import com.fruitfly.brain.Connectome;
import com.fruitfly.brain.LifConfig;
import com.fruitfly.brain.LifNetwork;
import java.io.*;
import java.util.*;
import java.util.stream.*;

/** Code-review assay: four neutral feature channels, not preassigned good/bad stimuli. */
public final class ReviewBrainBridge {
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
    public static void main(String[] args) throws Exception {
        Connectome c;
        try (InputStream in = new FileInputStream(args[0])) { c = Connectome.load(in); }
        Set<String> types = Set.of("LB3b", "LB3c", "PhG1a", "PhG1b", "PhG1c", "LgLG3", "LC4", "LPLC2");
        int[] candidates = c.indicesWhere(i -> types.contains(c.type(i)) || Set.of("wind_gravity", "grooming").contains(c.subclass(i)));
        int[][] groups = new int[4][];
        for (int k = 0; k < 4; k++) {
            final int group = k;
            // Stable neutral partition of a MIXTURE of gustatory/mechanosensory/visual inputs.
            // No feature is assigned to a dedicated approve or reject pathway.
            groups[k] = Arrays.stream(candidates).filter(i -> Math.floorMod(Long.hashCode(c.bodyId[i]), 4) == group).toArray();
            if (groups[k].length == 0) throw new IllegalStateException("Empty feature channel");
        }
        int[][] outputs = {c.indicesOfType("MN9"), c.indicesOfType("DNg62"), c.indicesOfType("DNp01")};
        for (int[] output : outputs) if (output.length == 0) throw new IllegalStateException("Missing readout population");
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
        System.out.printf(Locale.ROOT, "{\"neurons\":%d,\"connections\":%d,\"groups\":[%d,%d,%d,%d],\"projection\":%s,\"geometry3d\":%s,\"links3d\":%s}%n", c.n, c.nEdges, groups[0].length, groups[1].length, groups[2].length, groups[3].length, projection, geometry, links);
        if (args.length > 1 && args[1].equals("--anatomy")) return;
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        String line = reader.readLine();
        if (line == null) return;
        String[] fields = line.split("\\t");
        if (fields.length != 6) throw new IllegalArgumentException("Expected seed, four rates, gain");
        LifConfig cfg = new LifConfig();
        cfg.seed = Long.parseLong(fields[0]); cfg.dtMs = .5; cfg.threads = 1; cfg.spikeLogCapacity = 0;
        cfg.gain = Double.parseDouble(fields[5]);
        if (!Double.isFinite(cfg.gain) || cfg.gain < 0 || cfg.gain > 1) throw new IllegalArgumentException("Invalid gain");
        LifNetwork net = new LifNetwork(c, cfg);
        net.setPostsynapticGain(c.indicesOfClass("Kenyon_Cell"), .25);
        for (int k = 0; k < 4; k++) {
            double hz = Double.parseDouble(fields[k+1]);
            if (!Double.isFinite(hz) || hz < 0 || hz > 200) throw new IllegalArgumentException("Invalid stimulus");
            net.setStimulusRate(groups[k], hz);
        }
        long start = System.nanoTime();
        net.runMs(200); net.endTick(200);
        int[] totals = new int[c.n];
        int[] outputSpikes = new int[3];
        StringJoiner frames = new StringJoiner(",", "[", "]");
        for (int frame = 0; frame < 10; frame++) {
            long before = net.totalSpikes();
            net.runMs(25);
            int[] counts = new int[c.n];
            for (int i = 0; i < c.n; i++) { counts[i] = net.spikesThisTick(i); totals[i] += counts[i]; }
            for (int k = 0; k < 3; k++) outputSpikes[k] += net.spikesThisTick(outputs[k]);
            frames.add(String.format(Locale.ROOT,
                "{\"timeMs\":%d,\"feedHz\":%.3f,\"groomHz\":%.3f,\"escapeHz\":%.3f,\"spikes\":%d,\"inputSpikes\":[%d,%d,%d,%d],\"activity\":%s,\"activity3d\":%s}",
                225 + frame*25, net.populationRateHz(outputs[0],25), net.populationRateHz(outputs[1],25), net.populationRateHz(outputs[2],25), net.totalSpikes()-before,
                net.spikesThisTick(groups[0]),net.spikesThisTick(groups[1]),net.spikesThisTick(groups[2]),net.spikesThisTick(groups[3]),points(c,counts,100),points3d(c,counts,100)));
            net.endTick(25);
        }
        System.out.printf(Locale.ROOT,
            "{\"feedHz\":%.3f,\"groomHz\":%.3f,\"escapeHz\":%.3f,\"spikes\":%d,\"wallMs\":%.3f,\"simulatedMs\":450,\"frames\":%s,\"activity\":%s}%n",
            outputSpikes[0]*1000.0/(outputs[0].length*250),outputSpikes[1]*1000.0/(outputs[1].length*250),outputSpikes[2]*1000.0/(outputs[2].length*250),
            net.totalSpikes(),(System.nanoTime()-start)/1e6,frames,points(c,totals,300));
    }
}
