import com.fruitfly.brain.Connectome;
import com.fruitfly.brain.LifConfig;
import com.fruitfly.brain.LifNetwork;
import java.io.*;
import java.util.*;
import java.util.stream.*;

/**
 * Stimulates named sensory populations of the connectome, lets the mushroom body's own dopamine neurons gate synaptic
 * change while it is being taught, and records three motor readouts plus the MBON populations.
 */
public final class ReviewBrainBridge {
    /** Simulation tick (ms). Plasticity, eligibility, and dopamine are evaluated once per tick. */
    static final double TICK_MS = 5.0;
    static final int SETTLE_TICKS = 40, FRAME_TICKS = 5, FRAMES = 10, TOTAL_TICKS = SETTLE_TICKS + FRAME_TICKS * FRAMES;
    /** A Kenyon cell that fired within this window is eligible: its output synapses can be depressed by dopamine. */
    static final int ELIGIBLE_TICKS = 20;
    /** Sensory drive for a lesson. Bitter on the proboscis (punishment) and sugar on the proboscis (reward), in Hz. */
    static final double TASTE_HZ = 150.0;
    /**
     * The taste pathways into the dopamine neurons are incomplete in this model: sugar never fires the PAM cells (their
     * gustatory input falls below the connectome's synapse threshold) and bitter fires only some of the PPL1 cells. Each
     * taste is therefore paired with Poisson drive of its dopamine family at this rate, disclosed in every receipt. What
     * the taste does to the body is the fly's; which synapses the dopamine can change is the connectome's.
     */
    static final double DAN_HZ = 200.0;
    /** Exposure-driven dopamine in the α'3 compartment (PPL1-α'3, Hattori et al. 2017) while the fly reads a sequence. */
    static final double EXPOSURE_HZ = 200.0;

    static String points(Connectome c, int[] counts, int limit) {
        StringJoiner result = new StringJoiner(",", "[", "]");
        IntStream.range(0, c.n).filter(i -> c.hasSoma(i) && counts[i] > 0).boxed()
            .sorted(Comparator.comparingInt((Integer i) -> counts[i]).reversed()).limit(limit)
            .forEach(i -> result.add(String.format(Locale.ROOT, "[%.0f,%.0f,%d]", c.soma[3*i], c.soma[3*i+2], counts[i])));
        return result.toString();
    }
    static String points3d(Connectome c, int[] counts, int limit) {
        StringJoiner result = new StringJoiner(",", "[", "]");
        IntStream.range(0, c.n).filter(i -> c.hasSoma(i) && counts[i] > 0).boxed()
            .sorted(Comparator.comparingInt((Integer i) -> counts[i]).reversed()).limit(limit)
            .forEach(i -> result.add(String.format(Locale.ROOT, "[%.0f,%.0f,%.0f,%d]", c.soma[3*i], c.soma[3*i+1], c.soma[3*i+2], counts[i])));
        return result.toString();
    }
    /** Soma positions of one readout population, in a fixed order that per-frame counts follow. */
    static int[] withSoma(Connectome c, int[] population) {
        return Arrays.stream(population).filter(c::hasSoma).toArray();
    }
    static String somas(Connectome c, int[] neurons) {
        StringJoiner result = new StringJoiner(",", "[", "]");
        for (int i : neurons) result.add(String.format(Locale.ROOT, "[%.0f,%.0f,%.0f]", c.soma[3*i], c.soma[3*i+1], c.soma[3*i+2]));
        return result.toString();
    }
    static String counts(int[] counts, int[] neurons) {
        StringJoiner result = new StringJoiner(",", "[", "]");
        for (int i : neurons) result.add(Integer.toString(counts[i]));
        return result.toString();
    }
    static long sum(int[] counts, int[] neurons) { long s = 0; for (int i : neurons) s += counts[i]; return s; }
    static double hz(long spikes, int cells, double ms) { return cells == 0 ? 0 : spikes * 1000.0 / (cells * ms); }

    /** Degree-preserving shuffle: the postsynaptic targets of the given edges are permuted among those edges. */
    static void shuffle(Connectome c, int[] edges, long seed) {
        Random rng = new Random(seed);
        int[] posts = Arrays.stream(edges).map(e -> c.postIdx[e]).toArray();
        for (int i = posts.length - 1; i > 0; i--) { int j = rng.nextInt(i + 1); int t = posts[i]; posts[i] = posts[j]; posts[j] = t; }
        for (int i = 0; i < edges.length; i++) c.postIdx[edges[i]] = posts[i];
    }

    public static void main(String[] args) throws Exception {
        Connectome c;
        try (InputStream in = new FileInputStream(args[0])) { c = Connectome.load(in); }
        String memoryPath = null, shuffleSpec = null;
        boolean anatomyOnly = false;
        for (int a = 1; a < args.length; a++) {
            if (args[a].equals("--anatomy")) anatomyOnly = true;
            else if (args[a].startsWith("--shuffle=")) shuffleSpec = args[a].substring("--shuffle=".length());
            else if (args[a].startsWith("--")) throw new IllegalArgumentException("Unknown option " + args[a]);
            else memoryPath = args[a];
        }
        // Every stimulation names real annotated sensory populations. The review encoder and the poke buttons use the
        // same list; the name says where on the animal the input lands, not what we want the fly to conclude.
        LinkedHashMap<String, int[]> pokes = new LinkedHashMap<>();
        Set<String> sugarTypes = Set.of("LB3b", "LB3c", "PhG1a", "PhG1b", "PhG1c");
        Set<String> fruitTypes = Set.of("ORN_DM1", "ORN_DM2", "ORN_DM4", "ORN_VA2", "ORN_VM5d", "ORN_DL1");
        Set<String> pheromoneTypes = Set.of("ORN_DA1", "ORN_VA1v");
        Set<String> loomTypes = Set.of("LC4", "LPLC2");
        pokes.put("sugar", c.indicesWhere(i -> sugarTypes.contains(c.type(i))));
        pokes.put("feet", c.indicesWhere(i -> c.neuronClass(i).equals("gustatory") && c.subclass(i).equals("leg bristle")));
        pokes.put("antennae", c.indicesWhere(i -> Set.of("wind_gravity", "grooming").contains(c.subclass(i))));
        pokes.put("eyes", c.indicesWhere(i -> loomTypes.contains(c.type(i))));
        pokes.put("light", c.indicesOfType("R1-R6"));
        pokes.put("fruit", c.indicesWhere(i -> fruitTypes.contains(c.type(i))));
        pokes.put("pheromone", c.indicesWhere(i -> pheromoneTypes.contains(c.type(i))));
        pokes.put("mold", c.indicesOfType("ORN_DA2"));
        pokes.put("co2", c.indicesOfType("ORN_V"));
        pokes.put("bitter", c.indicesWhere(i -> c.type(i).startsWith("LB1")));
        pokes.put("brush", c.indicesWhere(i -> c.subclass(i).equals("mechanosensory bristle")));
        pokes.put("abdomen", c.indicesWhere(i -> c.subclass(i).equals("abdomen")));
        // Every olfactory glomerulus is addressable by its ORN type, so an arbitrary odor pattern can be presented.
        TreeSet<String> glomeruli = new TreeSet<>();
        for (int i = 0; i < c.n; i++) if (c.type(i).startsWith("ORN_")) glomeruli.add(c.type(i));
        for (String g : glomeruli) pokes.put(g, c.indicesOfType(g));
        StringJoiner pokeSizes = new StringJoiner(",", "{", "}");
        for (Map.Entry<String, int[]> e : pokes.entrySet()) {
            if (e.getValue().length == 0) throw new IllegalStateException("Empty poke population " + e.getKey());
            pokeSizes.add("\"" + e.getKey() + "\":" + e.getValue().length);
        }
        // The mushroom body. Kenyon cells carry the sparse odor code; MBONs read it out. A compartment's valence is
        // defined by its dopamine input (Aso et al. 2014): the MBONs whose compartments are innervated by PPL1 cells (the
        // ones punishment silences) drive approach, and the MBONs whose compartments are innervated by PAM cells (the
        // ones reward silences) drive avoidance. Both groups are read from the connectome's DAN -> MBON synapse counts,
        // majority rule per MBON, before any wiring ablation. The labels "approach" and "avoid" are the literature's; which
        // MBON carries which label is the wiring's. Learning never consults the labels: which synapses a lesson can change
        // is decided, synapse by synapse, by which dopamine neurons the connectome wires onto that MBON.
        int[] kenyon = c.indicesOfClass("Kenyon_Cell");
        boolean[] isKenyon = new boolean[c.n]; for (int k : kenyon) isKenyon[k] = true;
        int[] dans = c.indicesOfClass("DAN");
        int[] ppl1 = Arrays.stream(dans).filter(i -> c.type(i).startsWith("PPL1")).toArray();
        int[] pam = Arrays.stream(dans).filter(i -> c.type(i).startsWith("PAM")).toArray();
        // The α'3 compartment signals novelty: its MBONs answer an unfamiliar odor and fall quiet as the odor becomes
        // familiar, because exposure alone (dopamine from PPL1-α'3) depresses the KC synapses onto them (Hattori et al.
        // 2017). In hemibrain numbering MBON17 is MBON-α'3m, the class that shows the suppression; MBON16 (α'3ap) is
        // left out of every readout. Neither carries valence here.
        Set<String> noveltyTypes = Set.of("MBON17", "MBON17-like"), noValence = Set.of("MBON16", "MBON17", "MBON17-like");
        List<Integer> avoidList = new ArrayList<>(), approachList = new ArrayList<>(), noveltyList = new ArrayList<>();
        for (int i = 0; i < c.n; i++) {
            if (!c.type(i).startsWith("MBON")) continue;
            if (noveltyTypes.contains(c.type(i))) { noveltyList.add(i); continue; }
            if (noValence.contains(c.type(i))) continue;
            long fromPpl1 = 0, fromPam = 0;
            for (int d : ppl1) for (int e = c.rowPtr[d]; e < c.rowPtr[d+1]; e++) if (c.postIdx[e] == i) fromPpl1 += c.synapseCount(e);
            for (int d : pam) for (int e = c.rowPtr[d]; e < c.rowPtr[d+1]; e++) if (c.postIdx[e] == i) fromPam += c.synapseCount(e);
            if (fromPpl1 > fromPam) approachList.add(i); else if (fromPam > fromPpl1) avoidList.add(i);
        }
        int[] avoidMbons = avoidList.stream().mapToInt(Integer::intValue).toArray();
        int[] approachMbons = approachList.stream().mapToInt(Integer::intValue).toArray();
        int[] noveltyMbons = noveltyList.stream().mapToInt(Integer::intValue).toArray();
        if (noveltyMbons.length == 0 || avoidMbons.length == 0 || approachMbons.length == 0) throw new IllegalStateException("MBON groups not found");
        boolean[] isAvoid = new boolean[c.n], isApproach = new boolean[c.n], isNovelty = new boolean[c.n], isMbon = new boolean[c.n];
        for (int i : avoidMbons) { isAvoid[i] = true; isMbon[i] = true; }
        for (int i : approachMbons) { isApproach[i] = true; isMbon[i] = true; }
        for (int i : noveltyMbons) { isNovelty[i] = true; isMbon[i] = true; }
        // The α'3 dopamine neurons: the DANs whose MBON output lands mostly in the α'3 compartment (MBON16, MBON17).
        Set<String> alphaPrime3Mbons = Set.of("MBON16", "MBON17", "MBON17-like");
        int[] alphaPrime3 = Arrays.stream(dans).filter(i -> {
            int inside = 0, all = 0;
            for (int e = c.rowPtr[i]; e < c.rowPtr[i+1]; e++) { String t = c.type(c.postIdx[e]); if (!t.startsWith("MBON")) continue; all += c.synapseCount(e); if (alphaPrime3Mbons.contains(t)) inside += c.synapseCount(e); }
            return all > 0 && inside * 2 > all;
        }).toArray();
        boolean[] isAlphaPrime3 = new boolean[c.n]; for (int d : alphaPrime3) isAlphaPrime3[d] = true;
        // Punishment drives the PPL1 cells other than PPL1-α'3: shock's teaching neurons in the animal are the γ1pedc,
        // γ2α'1, α'2α2 and α3 cells, while α'3 dopamine is exposure-driven. Whatever bitter does to α'3 through the fly's
        // own wiring is left alone.
        int[] punishers = Arrays.stream(ppl1).filter(d -> !isAlphaPrime3[d]).toArray();
        if (ppl1.length == 0 || pam.length == 0 || alphaPrime3.length == 0 || punishers.length == 0) throw new IllegalStateException("Missing dopamine population");
        boolean[] isDan = new boolean[c.n]; for (int d : dans) isDan[d] = true;
        // Optional wiring ablations, applied before anything is derived from the graph. Each permutes the postsynaptic
        // targets of one edge class among themselves, so every cell keeps its in- and out-degree and only the identity of
        // who talks to whom is destroyed. Used to test whether the review depends on the fly's wiring or only on its statistics.
        if (shuffleSpec != null) {
            for (String part : shuffleSpec.split(",")) {
                String[] kv = part.split(":");
                long seed = kv.length > 1 ? Long.parseLong(kv[1]) : 1;
                int[] edges;
                switch (kv[0]) {
                    case "dan-mbon": edges = Arrays.stream(dans).flatMap(d -> IntStream.range(c.rowPtr[d], c.rowPtr[d+1])).filter(e -> c.type(c.postIdx[e]).startsWith("MBON")).toArray(); break;
                    case "kc-mbon": edges = Arrays.stream(kenyon).flatMap(k -> IntStream.range(c.rowPtr[k], c.rowPtr[k+1])).filter(e -> isMbon[c.postIdx[e]]).toArray(); break;
                    case "mbon-out": edges = IntStream.range(0, c.n).filter(i -> c.type(i).startsWith("MBON")).flatMap(m -> IntStream.range(c.rowPtr[m], c.rowPtr[m+1])).toArray(); break;
                    default: throw new IllegalArgumentException("Unknown shuffle " + kv[0]);
                }
                shuffle(c, edges, seed);
            }
        }
        // Odor identity is carried to the mushroom body by the real PN -> KC wiring. The simplified antennal lobe in this
        // LIF model saturates (any odor drives most projection neurons), so the odor code is computed structurally: for
        // each glomerulus, the Kenyon cells its projection neurons synapse onto, weighted by synapse count. An odor is a
        // set of glomerulus rates; the cells with the most weighted input (top 5%, standing in for APL inhibition) are
        // stimulated directly. Everything downstream, KC -> MBON included, is simulated.
        Map<String, float[]> glomerulusToKc = new HashMap<>();
        int[] kcIndexOf = new int[c.n]; Arrays.fill(kcIndexOf, -1);
        for (int j = 0; j < kenyon.length; j++) kcIndexOf[kenyon[j]] = j;
        for (String g : glomeruli) {
            String glom = g.substring(4);
            float[] w = new float[kenyon.length];
            for (int p : c.indicesWhere(i -> c.type(i).startsWith(glom + "_") && c.type(i).contains("PN")))
                for (int e = c.rowPtr[p]; e < c.rowPtr[p+1]; e++) if (kcIndexOf[c.postIdx[e]] >= 0) w[kcIndexOf[c.postIdx[e]]] += c.synapseCount(e);
            glomerulusToKc.put(g, w);
        }
        // Plastic synapses: every KC -> MBON edge onto a readout MBON. The memory file holds a factor per edge (1 = naive).
        int[] plasticEdges = Arrays.stream(kenyon).flatMap(k -> IntStream.range(c.rowPtr[k], c.rowPtr[k+1])).filter(e -> isMbon[c.postIdx[e]]).toArray();
        int[] plasticPre = new int[plasticEdges.length];
        for (int i = 0; i < plasticEdges.length; i++) plasticPre[i] = preOf(c, plasticEdges[i]);
        // Circuit configuration, alongside the Kenyon-cell input gain of 0.25 that keeps the odor code sparse (about 6%
        // of cells): KC -> MBON synapses are scaled up so the odor code, not other inputs, is what drives the MBONs.
        // Calibration (npm run calibrate) records the odor-evoked MBON rates this produces.
        final double KC_MBON_SCALE = 5.0;
        for (int e : plasticEdges) c.weight[e] = (short) Math.min(65535, Math.round((c.weight[e] & 0xFFFF) * KC_MBON_SCALE));
        int[] baseWeight = new int[plasticEdges.length];
        for (int i = 0; i < plasticEdges.length; i++) baseWeight[i] = c.weight[plasticEdges[i]] & 0xFFFF;
        // Compartments. For each plastic MBON, the dopamine neurons the connectome wires onto it and how strongly. The
        // dopamine a synapse onto that MBON sees in a tick is the synapse-weighted fraction of those cells that fired.
        int[][] compartmentDans = new int[c.n][]; double[][] compartmentWeights = new double[c.n][];
        int compartments = 0;
        for (int m = 0; m < c.n; m++) {
            if (!isMbon[m]) continue;
            List<int[]> inputs = new ArrayList<>();
            for (int d : dans) for (int e = c.rowPtr[d]; e < c.rowPtr[d+1]; e++) if (c.postIdx[e] == m) inputs.add(new int[]{d, c.synapseCount(e)});
            double total = inputs.stream().mapToDouble(x -> x[1]).sum();
            compartmentDans[m] = inputs.stream().mapToInt(x -> x[0]).toArray();
            compartmentWeights[m] = inputs.stream().mapToDouble(x -> total > 0 ? x[1] / total : 0).toArray();
            if (inputs.size() > 0) compartments++;
        }
        Map<Integer, Double> memory = new HashMap<>();
        if (memoryPath != null) {
            File file = new File(memoryPath);
            if (file.exists()) {
                String json = new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8);
                // Minimal parser for {"edges":[[edge,factor],...]}: the file is written by this program. Only the edges
                // array is scanned, so provenance stored alongside it (lessons, Kenyon-cell ids) can never be read as factors.
                int at = json.indexOf("\"edges\":[");
                if (at >= 0) {
                    int start = at + "\"edges\":[".length();
                    int end = json.startsWith("]", start) ? start : json.indexOf("]]", start) + 2;
                    if (end < start) throw new IllegalArgumentException("Unterminated edges array in memory file");
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\[(\\d+),([0-9.eE+-]+)\\]").matcher(json.substring(start, end));
                    while (m.find()) memory.put(Integer.parseInt(m.group(1)), Double.parseDouble(m.group(2)));
                }
            }
        }
        // Factors live per plastic edge; the memory applies them to the real synapse counts before the network is built.
        // The α'3 compartment is the exception: its depression is the fly's familiarity with what it has just smelled, a
        // short-lived memory (Hattori et al. 2017 followed it over minutes to hours), so it is never carried between
        // sessions. Whatever a lesson's dopamine does to the α'3 synapses happens inside that run and is not saved, and
        // α'3 factors in an older memory file are ignored. The valence compartments are the long-term memory.
        double[] factor = new double[plasticEdges.length];
        Arrays.fill(factor, 1.0);
        int[] plasticIndexOf = new int[c.nEdges]; Arrays.fill(plasticIndexOf, -1);
        for (int i = 0; i < plasticEdges.length; i++) plasticIndexOf[plasticEdges[i]] = i;
        memory.keySet().removeIf(edge -> edge < 0 || edge >= c.nEdges || plasticIndexOf[edge] < 0 || isNovelty[c.postIdx[edge]]);
        for (Map.Entry<Integer, Double> e : memory.entrySet()) {
            int edge = e.getKey();
            int i = plasticIndexOf[edge];
            factor[i] = Math.min(1.0, Math.max(0.0, e.getValue()));
            c.weight[edge] = (short) Math.max(0, Math.round(baseWeight[i] * factor[i]));
        }
        int[][] outputs = {c.indicesOfType("MN9"), c.indicesOfType("DNg62"), c.indicesOfType("DNp01")};
        for (int[] output : outputs) if (output.length == 0) throw new IllegalStateException("Missing readout population");
        // The three readout populations are exported with their real soma positions so the vote is visible in the anatomy.
        int[][] readoutSomas = {withSoma(c, outputs[0]), withSoma(c, outputs[1]), withSoma(c, outputs[2])};
        String readouts3d = "[" + somas(c, readoutSomas[0]) + "," + somas(c, readoutSomas[1]) + "," + somas(c, readoutSomas[2]) + "]";
        String readoutSizes = String.format(Locale.ROOT, "[%d,%d,%d]", outputs[0].length, outputs[1].length, outputs[2].length);
        StringJoiner projection = new StringJoiner(",", "[", "]");
        for (int i = 0; i < c.n; i += 67) if (c.hasSoma(i)) projection.add(String.format(Locale.ROOT, "[%.0f,%.0f]", c.soma[3*i], c.soma[3*i+2]));
        StringJoiner geometry = new StringJoiner(",", "[", "]");
        StringJoiner links = new StringJoiner(",", "[", "]");
        int linkCount = 0;
        for (int i = 0; i < c.n; i += 23) {
            if (!c.hasSoma(i)) continue;
            geometry.add(String.format(Locale.ROOT, "[%.0f,%.0f,%.0f]", c.soma[3*i], c.soma[3*i+1], c.soma[3*i+2]));
            // A bounded sample of actual graph edges. Straight soma-to-soma lines are SCHEMATIC, not axon morphology.
            if (linkCount >= 1600 || i % 3 != 0) continue;
            int strongest = -1;
            for (int k = c.rowPtr[i]; k < c.rowPtr[i+1]; k++) {
                if (c.hasSoma(c.postIdx[k]) && (strongest < 0 || c.synapseCount(k) > c.synapseCount(strongest))) strongest = k;
            }
            if (strongest >= 0) {
                int j = c.postIdx[strongest];
                // body IDs and weight are retained alongside the geometry for auditability.
                links.add(String.format(Locale.ROOT, "[%d,%d,%d,%.0f,%.0f,%.0f,%.0f,%.0f,%.0f]", c.bodyId[i], c.bodyId[j], c.synapseCount(strongest), c.soma[3*i], c.soma[3*i+1], c.soma[3*i+2], c.soma[3*j], c.soma[3*j+1], c.soma[3*j+2]));
                linkCount++;
            }
        }
        // The mushroom body in 3D: every fourth Kenyon cell with a soma, every MBON by class, and the dopamine neurons,
        // so the odor code, the vote, and the teaching signal can be watched in the anatomy.
        int[] kenyonSample = IntStream.range(0, kenyon.length).filter(j -> j % 4 == 0).map(j -> kenyon[j]).filter(c::hasSoma).toArray();
        int[] avoidSomas = withSoma(c, avoidMbons), approachSomas = withSoma(c, approachMbons), ppl1Somas = withSoma(c, ppl1), pamSomas = withSoma(c, pam);
        String mushroom3d = String.format(Locale.ROOT, "{\"kenyon\":%s,\"avoid\":%s,\"approach\":%s,\"ppl1\":%s,\"pam\":%s}", somas(c, kenyonSample), somas(c, avoidSomas), somas(c, approachSomas), somas(c, ppl1Somas), somas(c, pamSomas));
        String dopamine = String.format(Locale.ROOT, "{\"ppl1\":%d,\"pam\":%d,\"alphaPrime3\":%d,\"compartments\":%d,\"tasteHz\":%.0f,\"danHz\":%.0f,\"exposureHz\":%.0f,\"eligibleMs\":%.0f,\"tickMs\":%.0f}", ppl1.length, pam.length, alphaPrime3.length, compartments, TASTE_HZ, DAN_HZ, EXPOSURE_HZ, ELIGIBLE_TICKS * TICK_MS, TICK_MS);
        System.out.printf(Locale.ROOT, "{\"neurons\":%d,\"connections\":%d,\"readoutSizes\":%s,\"readouts3d\":%s,\"pokes\":%s,\"mushroomBody\":{\"kenyonCells\":%d,\"avoidMbons\":%d,\"approachMbons\":%d,\"noveltyMbons\":%d,\"plasticSynapses\":%d,\"rememberedSynapses\":%d,\"kcMbonScale\":%.1f,\"dopamine\":%s},\"shuffle\":%s,\"mushroom3d\":%s,\"projection\":%s,\"geometry3d\":%s,\"links3d\":%s}%n", c.n, c.nEdges, readoutSizes, readouts3d, pokeSizes, kenyon.length, avoidMbons.length, approachMbons.length, noveltyMbons.length, plasticEdges.length, memory.size(), KC_MBON_SCALE, dopamine, shuffleSpec == null ? "null" : "\"" + shuffleSpec + "\"", mushroom3d, projection, geometry, links);
        if (anatomyOnly) return;
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        String line = reader.readLine();
        if (line == null) return;
        String[] fields = line.split("\\t");
        // Two request shapes. A trial: seed \t gain \t name=hz[,name=hz...][\t lesson[\t rate]]. A review is a set of
        // named stimulations chosen by the encoder; a poke is one chosen by hand. The network cannot tell the difference,
        // which is the point. A sequence: seed \t gain \t sequence \t n[\t familiarity rate[\t readings]], then n stimulus
        // lines, each presented in turn to the same network so that what it has just smelled shapes how it answers the next.
        boolean sequence = fields.length >= 4 && fields[2].equals("sequence");
        if (!sequence && (fields.length < 3 || fields.length > 5)) throw new IllegalArgumentException("Expected seed, gain, stimuli[, lesson[, rate]]");
        String lesson = !sequence && fields.length > 3 ? fields[3] : "none";
        if (!Set.of("none", "punish", "reward").contains(lesson)) throw new IllegalArgumentException("Lesson must be none, punish, or reward");
        double eta = !sequence && fields.length > 4 ? Double.parseDouble(fields[4]) : 0.4;
        if (!Double.isFinite(eta) || eta <= 0 || eta > 1) throw new IllegalArgumentException("Invalid learning rate");
        if (!lesson.equals("none") && memoryPath == null) throw new IllegalArgumentException("A lesson needs a memory file");
        LifConfig cfg = new LifConfig();
        cfg.seed = Long.parseLong(fields[0]); cfg.dtMs = .5; cfg.threads = 1; cfg.spikeLogCapacity = 0;
        cfg.gain = Double.parseDouble(fields[1]);
        if (!Double.isFinite(cfg.gain) || cfg.gain < 0 || cfg.gain > 1) throw new IllegalArgumentException("Invalid gain");
        Circuit circuit = new Circuit(c, cfg, kenyon, isKenyon, glomerulusToKc, pokes, outputs, avoidMbons, approachMbons, noveltyMbons, ppl1, pam, alphaPrime3, punishers, readoutSomas, avoidSomas, approachSomas, ppl1Somas, pamSomas,
            plasticEdges, plasticPre, baseWeight, factor, compartmentDans, compartmentWeights);

        if (!sequence) {
            long start = System.nanoTime();
            // A lesson is a taste delivered while the odor is on. Bitter (punishment) reaches the PPL1 dopamine neurons
            // through the fly's own circuits; sugar (reward) is paired with drive of the PAM neurons. Inside the run, a
            // KC -> MBON synapse is depressed in every tick in which its Kenyon cell has fired recently AND the dopamine
            // neurons the connectome wires onto that MBON fired. Which synapses can change is anatomy; how much, the rate.
            Trial t = circuit.run(fields[2], lesson, eta);
            if (!lesson.equals("none")) {
                for (int i = 0; i < plasticEdges.length; i++) {
                    if (isNovelty[c.postIdx[plasticEdges[i]]]) continue;
                    if (factor[i] < 1.0) memory.put(plasticEdges[i], factor[i]); else memory.remove(plasticEdges[i]);
                }
                StringBuilder out = new StringBuilder("{\"edges\":[");
                boolean first = true;
                for (Map.Entry<Integer, Double> e : new TreeMap<>(memory).entrySet()) {
                    if (!first) out.append(','); first = false;
                    out.append('[').append(e.getKey()).append(',').append(String.format(Locale.ROOT, "%.4f", e.getValue())).append(']');
                }
                out.append("]}\n");
                File target = new File(memoryPath), temp = new File(memoryPath + ".tmp");
                java.nio.file.Files.write(temp.toPath(), out.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                java.nio.file.Files.move(temp.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            }
            System.out.println(t.json(c, lesson, memory.size(), (System.nanoTime() - start) / 1e6, true));
            return;
        }

        // A sequence: the fly reads the diff, then reads it again. Each stimulus is a puff of odor to a rested animal:
        // every puff starts from the same membrane state and the same noise seed, and only the synapses carry over.
        // During the reading pass(es) the α'3 compartment's own dopamine neuron fires with each puff (exposure-driven
        // dopamine, Hattori et al. 2017), so the Kenyon cells carrying that puff have their synapses onto the α'3 MBONs
        // depressed by the same rule a lesson uses: a smell that recurs through the diff fades with every recurrence and
        // a smell that occurs once fades least. The final pass is a readout with the synapses frozen, so its answer does
        // not depend on the order of the hunks: what still sounds new is what is unlike the rest. Each puff is also run
        // once with those synapses restored, to measure what it would have evoked on first exposure; the two together
        // give a familiarity index. All of this is run-local: the fly's familiarity with this review is never saved.
        int count = Integer.parseInt(fields[3]);
        if (count < 1 || count > 64) throw new IllegalArgumentException("A sequence holds 1 to 64 stimuli");
        double familiarity = fields.length > 4 ? Double.parseDouble(fields[4]) : 0.3;
        if (!Double.isFinite(familiarity) || familiarity < 0 || familiarity > 1) throw new IllegalArgumentException("Invalid familiarity rate");
        int readings = fields.length > 5 ? Integer.parseInt(fields[5]) : 1;
        if (readings < 0 || readings > 3) throw new IllegalArgumentException("0 to 3 reading passes");
        long start = System.nanoTime();
        String[] stimuli = new String[count];
        for (int h = 0; h < count; h++) {
            stimuli[h] = reader.readLine();
            if (stimuli[h] == null) throw new IllegalArgumentException("Sequence ended early");
        }
        double[] fresh = factor.clone();
        int[] familiarized = new int[count];
        if (familiarity > 0) for (int pass = 0; pass < readings; pass++) {
            for (int h = 0; h < count; h++) {
                Trial t = circuit.run(stimuli[h], "expose", familiarity);
                familiarized[h] += t.depressed;
            }
        }
        // Reading familiarizes; it does not teach. Driving the α'3 dopamine neurons also recruits other PPL1 cells through
        // the wiring (more so in a fly whose approach MBONs, which inhibit them, have been silenced by lessons), so the
        // exposure passes nudge valence synapses too. Only the α'3 synapses carry over into the readout: every hunk's
        // valence is measured against the long-term memory alone, exactly as a single smell would be.
        double[] familiar = fresh.clone();
        for (int i = 0; i < plasticEdges.length; i++) if (isNovelty[c.postIdx[plasticEdges[i]]]) familiar[i] = factor[i];
        List<Trial> trials = new ArrayList<>();
        double[] naiveNovelty = new double[count];
        for (int h = 0; h < count; h++) {
            circuit.restore(fresh);
            naiveNovelty[h] = circuit.run(stimuli[h], "none", 0).noveltyHz();
            circuit.restore(familiar);
            trials.add(circuit.run(stimuli[h], "none", 0));
        }
        circuit.restore(fresh);
        // The fly looked at the puff its novelty MBONs answered loudest. That trial is reported in full, with frames, so the
        // viewer shows the moment; every puff is summarized.
        int looked = 0;
        for (int h = 1; h < count; h++) if (trials.get(h).noveltyHz() > trials.get(looked).noveltyHz()) looked = h;
        StringJoiner hunks = new StringJoiner(",", "[", "]");
        for (int h = 0; h < count; h++) {
            Trial t = trials.get(h);
            double index = naiveNovelty[h] > 0 ? 1.0 - t.noveltyHz() / naiveNovelty[h] : 0.0;
            hunks.add(String.format(Locale.ROOT, "{\"index\":%d,\"avoidHz\":%.3f,\"approachHz\":%.3f,\"noveltyHz\":%.3f,\"naiveNoveltyHz\":%.3f,\"familiarity\":%.3f,\"feedHz\":%.3f,\"activeKenyon\":%d,\"familiarized\":%d}", h, t.avoidHz(), t.approachHz(), t.noveltyHz(), naiveNovelty[h], Math.max(0, Math.min(1, index)), t.feedHz(), t.activeKenyon.size(), familiarized[h]));
        }
        Trial t = trials.get(looked);
        String single = t.json(c, "none", memory.size(), (System.nanoTime() - start) / 1e6, true);
        System.out.println(single.substring(0, single.length() - 1) + String.format(Locale.ROOT, ",\"sequence\":{\"looked\":%d,\"familiarity\":%.2f,\"readings\":%d,\"hunks\":%s}}", looked, familiarity, readings, hunks));
    }

    /** The presynaptic neuron of edge e (edges are stored in row order). */
    static int preOf(Connectome c, int e) {
        int lo = 0, hi = c.n - 1;
        while (lo < hi) { int mid = (lo + hi + 1) >>> 1; if (c.rowPtr[mid] <= e) lo = mid; else hi = mid - 1; }
        return lo;
    }

    /** The populations one trial stimulates and reads. Every trial runs on a freshly built network with the same seed. */
    static final class Circuit {
        final Connectome c; final LifConfig cfg; final int[] kenyon; final boolean[] isKenyon; final Map<String, float[]> glomerulusToKc;
        /** Kenyon-cell indices (into kenyon[]) grouped by class: KCab, KCa'b', KCg, and anything unclassified. */
        final LinkedHashMap<String, List<Integer>> kenyonClasses = new LinkedHashMap<>();
        final LinkedHashMap<String, int[]> pokes; final int[][] outputs; final int[] avoidMbons, approachMbons, noveltyMbons, ppl1, pam, alphaPrime3, punishers;
        final int[][] readoutSomas; final int[] avoidSomas, approachSomas, ppl1Somas, pamSomas;
        final int[] plasticEdges, plasticPre, baseWeight; final double[] factor; final int[][] compartmentDans; final double[][] compartmentWeights;
        Circuit(Connectome c, LifConfig cfg, int[] kenyon, boolean[] isKenyon, Map<String, float[]> glomerulusToKc, LinkedHashMap<String, int[]> pokes, int[][] outputs, int[] avoidMbons, int[] approachMbons, int[] noveltyMbons, int[] ppl1, int[] pam, int[] alphaPrime3, int[] punishers, int[][] readoutSomas, int[] avoidSomas, int[] approachSomas, int[] ppl1Somas, int[] pamSomas,
                int[] plasticEdges, int[] plasticPre, int[] baseWeight, double[] factor, int[][] compartmentDans, double[][] compartmentWeights) {
            this.c = c; this.cfg = cfg; this.kenyon = kenyon; this.isKenyon = isKenyon;
            for (int j = 0; j < kenyon.length; j++) {
                String t = c.type(kenyon[j]);
                String cls = t.startsWith("KCab") ? "KCab" : t.startsWith("KCa'b'") ? "KCa'b'" : t.startsWith("KCg") ? "KCg" : "KC";
                kenyonClasses.computeIfAbsent(cls, k -> new ArrayList<>()).add(j);
            } this.glomerulusToKc = glomerulusToKc; this.pokes = pokes; this.outputs = outputs;
            this.avoidMbons = avoidMbons; this.approachMbons = approachMbons; this.noveltyMbons = noveltyMbons; this.ppl1 = ppl1; this.pam = pam; this.alphaPrime3 = alphaPrime3; this.punishers = punishers;
            this.readoutSomas = readoutSomas; this.avoidSomas = avoidSomas; this.approachSomas = approachSomas; this.ppl1Somas = ppl1Somas; this.pamSomas = pamSomas;
            this.plasticEdges = plasticEdges; this.plasticPre = plasticPre; this.baseWeight = baseWeight; this.factor = factor; this.compartmentDans = compartmentDans; this.compartmentWeights = compartmentWeights;
        }
        /** Put every plastic synapse back to the given factors (run-local familiarity is undone this way). */
        void restore(double[] factors) {
            System.arraycopy(factors, 0, factor, 0, factor.length);
            for (int i = 0; i < plasticEdges.length; i++) c.weight[plasticEdges[i]] = (short) Math.max(0, Math.round(baseWeight[i] * factor[i]));
        }
        /**
         * Present one stimulus set: 200 ms to settle, then 250 ms recorded in ten frames. With a lesson ("punish",
         * "reward") or exposure ("expose"), the teaching input is on for the whole trial and plasticity runs every tick.
         */
        Trial run(String stimuliField, String lesson, double rate) {
            LifNetwork net = new LifNetwork(c, cfg);
            net.setPostsynapticGain(c.indicesOfClass("Kenyon_Cell"), .25);
            List<int[]> stimulated = new ArrayList<>();
            // "none" runs the network from rest with no input at all: the control for a change Jev found nothing to say about.
            Map<String, Double> odor = new LinkedHashMap<>();
            for (String pair : stimuliField.equals("none") ? new String[0] : stimuliField.split(",")) {
                String[] kv = pair.split("=");
                if (kv.length != 2) throw new IllegalArgumentException("Malformed stimulus");
                double hz = Double.parseDouble(kv[1]);
                if (!Double.isFinite(hz) || hz < 0 || hz > 200) throw new IllegalArgumentException("Invalid stimulus");
                if (kv[0].startsWith("odor:")) {
                    String g = kv[0].substring(5);
                    if (!glomerulusToKc.containsKey(g)) throw new IllegalArgumentException("Unknown glomerulus " + g);
                    odor.put(g, hz);
                    continue;
                }
                if (!pokes.containsKey(kv[0])) throw new IllegalArgumentException("Unknown population");
                net.setStimulusRate(pokes.get(kv[0]), hz);
                stimulated.add(pokes.get(kv[0]));
            }
            if (!odor.isEmpty()) {
                double[] drive = new double[kenyon.length];
                for (Map.Entry<String, Double> e : odor.entrySet()) { float[] w = glomerulusToKc.get(e.getKey()); for (int j = 0; j < w.length; j++) drive[j] += w[j] * e.getValue(); }
                // Sparsity is enforced within each Kenyon-cell class (αβ, α'β', γ), as each class has its own APL
                // inhibition and its own output compartments: the 5% code reaches every lobe, so an odor that mostly
                // excites αβ cells still has an α'β' code for the α'3 novelty MBONs to read.
                List<Integer> chosen = new ArrayList<>();
                for (List<Integer> members : kenyonClasses.values()) {
                    Integer[] order = members.toArray(new Integer[0]);
                    Arrays.sort(order, (x, y) -> Double.compare(drive[y], drive[x]));
                    int take = Math.max(1, (int) Math.round(order.length * 0.05));
                    double top = drive[order[0]];
                    for (int j = 0; j < take && drive[order[j]] > 0; j++) {
                        chosen.add(order[j]);
                        net.setStimulusRate(kenyon[order[j]], 60 + 120 * drive[order[j]] / top);
                    }
                }
                stimulated.add(chosen.stream().mapToInt(j -> kenyon[j]).toArray());
            }
            Trial t = new Trial();
            t.circuit = this;
            t.lesson = lesson;
            boolean plastic = !lesson.equals("none");
            switch (lesson) {
                case "punish": net.setStimulusRate(pokes.get("bitter"), TASTE_HZ); stimulated.add(pokes.get("bitter")); net.setStimulusRate(punishers, DAN_HZ); stimulated.add(punishers); t.pathway = "bitter+ppl1"; break;
                case "reward": net.setStimulusRate(pokes.get("sugar"), TASTE_HZ); stimulated.add(pokes.get("sugar")); net.setStimulusRate(pam, DAN_HZ); stimulated.add(pam); t.pathway = "sugar+pam"; break;
                case "expose": net.setStimulusRate(alphaPrime3, EXPOSURE_HZ); stimulated.add(alphaPrime3); t.pathway = "alphaPrime3"; break;
                case "none": break;
                default: throw new IllegalArgumentException("Unknown lesson " + lesson);
            }
            // Per-tick depression such that a synapse whose Kenyon cell is eligible under fully firing dopamine neurons
            // for the whole trial ends at (1 - rate) of its strength.
            double etaTick = plastic ? 1.0 - Math.pow(1.0 - rate, 1.0 / TOTAL_TICKS) : 0;
            int[] lastSpike = new int[c.n]; Arrays.fill(lastSpike, Integer.MIN_VALUE / 2);
            double[] dopa = new double[c.n];
            // A synapse counts as depressed by this trial when it lost at least 2% of its strength: a compartment that saw
            // a trickle of the wrong family's dopamine (PAM synapses onto a PPL1-dominated MBON, or vice versa) is nudged,
            // not taught, and the receipt should say so.
            double[] startFactor = factor.clone();
            boolean[] changed = new boolean[plasticEdges.length];
            double[] compartmentDopa = new double[c.n];
            t.totals = new int[c.n];
            int[] frameCounts = new int[c.n];
            StringJoiner frames = new StringJoiner(",", "[", "]");
            long frameSpikeBase = 0;
            for (int tick = 0; tick < TOTAL_TICKS; tick++) {
                net.runMs(TICK_MS);
                boolean recorded = tick >= SETTLE_TICKS;
                for (int i = 0; i < c.n; i++) {
                    int s = net.spikesThisTick(i);
                    if (s == 0) continue;
                    if (isKenyon[i]) lastSpike[i] = tick;
                    if (recorded) { frameCounts[i] += s; t.totals[i] += s; }
                }
                t.ppl1Spikes += net.spikesThisTick(ppl1); t.pamSpikes += net.spikesThisTick(pam); t.alphaPrime3Spikes += net.spikesThisTick(alphaPrime3);
                if (plastic) {
                    // Dopamine per compartment this tick: the synapse-weighted fraction of the MBON's dopamine neurons that fired.
                    for (int m = 0; m < c.n; m++) {
                        int[] ds = compartmentDans[m];
                        if (ds == null || ds.length == 0) continue;
                        double d = 0;
                        for (int q = 0; q < ds.length; q++) d += compartmentWeights[m][q] * Math.min(1, net.spikesThisTick(ds[q]));
                        dopa[m] = Math.min(1.0, d);
                        compartmentDopa[m] += dopa[m];
                    }
                    for (int i = 0; i < plasticEdges.length; i++) {
                        int k = plasticPre[i];
                        if (tick - lastSpike[k] > ELIGIBLE_TICKS) continue;
                        double d = dopa[c.postIdx[plasticEdges[i]]];
                        if (d <= 0) continue;
                        factor[i] *= 1.0 - etaTick * d;
                        c.weight[plasticEdges[i]] = (short) Math.max(0, Math.round(baseWeight[i] * factor[i]));
                        changed[i] = factor[i] < startFactor[i] * 0.98;
                    }
                }
                net.endTick(TICK_MS);
                if (recorded && (tick - SETTLE_TICKS) % FRAME_TICKS == FRAME_TICKS - 1) {
                    int frame = (tick - SETTLE_TICKS) / FRAME_TICKS;
                    double window = FRAME_TICKS * TICK_MS;
                    for (int k = 0; k < 3; k++) t.outputSpikes[k] += sum(frameCounts, outputs[k]);
                    t.avoidSpikes += sum(frameCounts, avoidMbons); t.approachSpikes += sum(frameCounts, approachMbons); t.noveltySpikes += sum(frameCounts, noveltyMbons);
                    int kcNow = 0; for (int k : kenyon) if (frameCounts[k] > 0) kcNow++;
                    StringJoiner kenyonActive = new StringJoiner(",", "[", "]");
                    for (int k : kenyon) if (frameCounts[k] > 0 && c.hasSoma(k)) kenyonActive.add(String.format(Locale.ROOT, "[%.0f,%.0f,%.0f]", c.soma[3*k], c.soma[3*k+1], c.soma[3*k+2]));
                    StringJoiner inputSpikes = new StringJoiner(",", "[", "]");
                    for (int[] population : stimulated) inputSpikes.add(Long.toString(sum(frameCounts, population)));
                    frames.add(String.format(Locale.ROOT,
                        "{\"timeMs\":%d,\"feedHz\":%.3f,\"groomHz\":%.3f,\"escapeHz\":%.3f,\"avoidHz\":%.3f,\"approachHz\":%.3f,\"noveltyHz\":%.3f,\"ppl1Hz\":%.3f,\"pamHz\":%.3f,\"activeKenyon\":%d,\"spikes\":%d,\"inputSpikes\":%s,\"activity\":%s,\"activity3d\":%s,\"readoutCounts\":[%s,%s,%s],\"kenyonActive3d\":%s,\"mbonCounts\":[%s,%s],\"danCounts\":[%s,%s]}",
                        225 + frame*25, hz(sum(frameCounts, outputs[0]), outputs[0].length, window), hz(sum(frameCounts, outputs[1]), outputs[1].length, window), hz(sum(frameCounts, outputs[2]), outputs[2].length, window),
                        hz(sum(frameCounts, avoidMbons), avoidMbons.length, window), hz(sum(frameCounts, approachMbons), approachMbons.length, window), hz(sum(frameCounts, noveltyMbons), noveltyMbons.length, window),
                        hz(sum(frameCounts, ppl1), ppl1.length, window), hz(sum(frameCounts, pam), pam.length, window), kcNow, net.totalSpikes() - frameSpikeBase,
                        inputSpikes, points(c, frameCounts, 100), points3d(c, frameCounts, 100),
                        counts(frameCounts, readoutSomas[0]), counts(frameCounts, readoutSomas[1]), counts(frameCounts, readoutSomas[2]), kenyonActive, counts(frameCounts, avoidSomas), counts(frameCounts, approachSomas), counts(frameCounts, ppl1Somas), counts(frameCounts, pamSomas)));
                    frameSpikeBase = net.totalSpikes();
                    Arrays.fill(frameCounts, 0);
                }
            }
            t.frames = frames.toString();
            // The odor code: Kenyon cells that fired at all during the recorded 250 ms.
            for (int k : kenyon) if (t.totals[k] > 0) t.activeKenyon.add(k);
            t.spikes = net.totalSpikes();
            if (plastic) {
                // The receipt: per MBON type, how much dopamine its compartment saw (mean over ticks) and what changed.
                TreeMap<String, double[]> byType = new TreeMap<>();
                for (int i = 0; i < plasticEdges.length; i++) {
                    if (!changed[i]) continue;
                    t.depressed++;
                    int m = c.postIdx[plasticEdges[i]];
                    double[] acc = byType.computeIfAbsent(c.type(m), x -> new double[]{0, 0, compartmentDopa[m] / TOTAL_TICKS, 0});
                    acc[0]++; acc[1] += factor[i];
                }
                StringJoiner comps = new StringJoiner(",", "{", "}");
                for (Map.Entry<String, double[]> e : byType.entrySet()) {
                    int m = -1; for (int i : avoidMbons) if (c.type(i).equals(e.getKey())) m = i; String group = m >= 0 ? "avoid" : "approach";
                    for (int i : noveltyMbons) if (c.type(i).equals(e.getKey())) group = "novelty";
                    comps.add(String.format(Locale.ROOT, "\"%s\":{\"group\":\"%s\",\"depressed\":%d,\"meanFactor\":%.3f,\"dopamine\":%.3f}", e.getKey(), group, (int) e.getValue()[0], e.getValue()[1] / e.getValue()[0], e.getValue()[2]));
                }
                t.compartments = comps.toString();
            }
            return t;
        }
    }

    /** One presentation's measurements. */
    static final class Trial {
        int[] totals; String frames; long[] outputSpikes = new long[3]; long avoidSpikes, approachSpikes, noveltySpikes, spikes, ppl1Spikes, pamSpikes, alphaPrime3Spikes;
        List<Integer> activeKenyon = new ArrayList<>();
        Circuit circuit; String lesson = "none", pathway = null, compartments = "{}"; int depressed;
        double feedHz() { return hz(outputSpikes[0], circuit.outputs[0].length, 250); }
        double avoidHz() { return hz(avoidSpikes, circuit.avoidMbons.length, 250); }
        double approachHz() { return hz(approachSpikes, circuit.approachMbons.length, 250); }
        double noveltyHz() { return hz(noveltySpikes, circuit.noveltyMbons.length, 250); }
        String json(Connectome c, String lesson, int remembered, double wallMs, boolean withFrames) {
            StringJoiner kcList = new StringJoiner(",", "[", "]");
            for (int k : activeKenyon) kcList.add(Long.toString(c.bodyId[k]));
            int[][] outputs = circuit.outputs;
            double trialMs = TOTAL_TICKS * TICK_MS;
            String teaching = pathway == null ? "null" : String.format(Locale.ROOT, "{\"pathway\":\"%s\",\"ppl1Spikes\":%d,\"pamSpikes\":%d,\"alphaPrime3Spikes\":%d,\"compartments\":%s}", pathway, ppl1Spikes, pamSpikes, alphaPrime3Spikes, compartments);
            return String.format(Locale.ROOT,
                "{\"feedHz\":%.3f,\"groomHz\":%.3f,\"escapeHz\":%.3f,\"avoidHz\":%.3f,\"approachHz\":%.3f,\"noveltyHz\":%.3f,\"ppl1Hz\":%.3f,\"pamHz\":%.3f,\"activeKenyon\":%d,\"activeKenyonIds\":%s,\"lesson\":\"%s\",\"depressed\":%d,\"rememberedSynapses\":%d,\"teaching\":%s,\"spikes\":%d,\"wallMs\":%.3f,\"simulatedMs\":450,\"frames\":%s,\"activity\":%s}",
                feedHz(), hz(outputSpikes[1], outputs[1].length, 250), hz(outputSpikes[2], outputs[2].length, 250),
                avoidHz(), approachHz(), noveltyHz(), hz(ppl1Spikes, circuit.ppl1.length, trialMs), hz(pamSpikes, circuit.pam.length, trialMs), activeKenyon.size(), kcList, lesson, depressed, remembered, teaching,
                spikes, wallMs, withFrames ? frames : "[]", points(c, totals, 300));
        }
    }
}
