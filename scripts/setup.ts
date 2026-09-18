import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { atomicJSON, command, hash, ROOT } from '../src/io.ts';

const revision = 'd91f06ab812333c0d1bd79da1fc29e34bf383163';
const dataHash = 'e33df182bed7a6f3ea279daf4790a82b05706d3d41e819a6a80c0473e8c559f3';
const runtime = join(ROOT, '.runtime');
await mkdir(runtime, { recursive: true });
await mkdir(join(ROOT, 'data'), { recursive: true });

async function download(url: string, destination: string, expectedHash: string): Promise<void> {
  try { if (hash(await readFile(destination)) === expectedHash) return; } catch {}
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const temporary = `${destination}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (hash(await readFile(temporary)) !== expectedHash) throw new Error('Checksum mismatch');
    const { rename } = await import('node:fs/promises');
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

let java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
let javac = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/javac') : 'javac';
try {
  const version = await command(javac, ['-version']);
  if (Number(version.match(/javac (\d+)/)?.[1] ?? 0) < 21) throw new Error('Need JDK 21+');
} catch {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('Install JDK 21+ and set JAVA_HOME, then rerun npm run setup.');
  }
  let directory = (await readdir(runtime)).find(name => name.startsWith('jdk-'));
  if (!directory) {
    const os = process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const response = await fetch(`https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`JDK metadata HTTP ${response.status}`);
    const assets = await response.json() as { binary: { package: { link: string; checksum: string } } }[];
    const asset = assets[0]?.binary.package;
    if (!asset?.link || !/^[a-f0-9]{64}$/.test(asset.checksum)) throw new Error('Invalid JDK metadata');
    const archive = join(runtime, 'jdk.tar.gz');
    await download(asset.link, archive, asset.checksum);
    await command('tar', ['-xzf', archive, '-C', runtime], '', 60_000);
    await rm(archive);
    directory = (await readdir(runtime)).find(name => name.startsWith('jdk-'));
  }
  if (!directory) throw new Error('JDK extraction failed');
  const home = join(runtime, directory, process.platform === 'darwin' ? 'Contents/Home' : '');
  java = join(home, 'bin/java');
  javac = join(home, 'bin/javac');
}
await download(
  `https://raw.githubusercontent.com/XprismDev/FlyBrainMC/${revision}/src/main/resources/connectome/malecns-v1.0.flyb.gz`,
  join(ROOT, 'data/malecns-v1.0.flyb.gz'), dataHash,
);
await mkdir(join(runtime, 'classes'), { recursive: true });
await command(javac, ['-d', join(runtime, 'classes'), ...['Connectome', 'LifConfig', 'LifNetwork'].map(name => join(ROOT, `vendor/flybrain/${name}.java`)), join(ROOT, 'brain/ReviewBrainBridge.java')]);
await atomicJSON(join(runtime, 'config.json'), { java, revision, dataHash });
const anatomy = JSON.parse(await command(java, ['-Xmx512m', '-cp', join(runtime, 'classes'), 'ReviewBrainBridge', join(ROOT, 'data/malecns-v1.0.flyb.gz'), '--anatomy']));
await atomicJSON(join(runtime, 'review-anatomy.json'), anatomy);
console.log('fly-review is ready. Run npm run demo, then open http://localhost:4488.');
