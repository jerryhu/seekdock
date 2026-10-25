import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import {
	RUNTIME_ROLES,
	hostRuntimeTarget,
	loadRuntimeManifest,
	verifyPreparedRuntime,
} from './prepare-runtime.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = process.argv[2] ?? hostRuntimeTarget();
if (target === undefined) {
	throw new Error(`No SeekDock runtime target is defined for ${process.platform}-${process.arch}.`);
}

const manifest = await loadRuntimeManifest(root);
const runtime = manifest.targets[target];
if (runtime === undefined || typeof runtime !== 'object') {
	throw new Error(`Runtime manifest has no ${target} target.`);
}

await verifyPreparedRuntime({ root, target });

const sourceDirectory = join(root, 'resources', 'runtime', target);
const outputDirectory = join(root, 'dist', 'runtime-assets');
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const checksums = [];
for (const role of RUNTIME_ROLES) {
	const artifact = runtime.artifacts?.[role];
	if (artifact === undefined) {
		continue;
	}
	const sourcePath = join(sourceDirectory, runtime[role]);
	const outputPath = join(outputDirectory, artifact.asset);
	await pipeline(createReadStream(sourcePath), createGzip({ level: 1 }), createWriteStream(outputPath));
	checksums.push(`${await hashFile(outputPath)}  ${artifact.asset}`);
}
for (const filename of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
	await copyFile(join(sourceDirectory, filename), join(outputDirectory, filename));
}
await writeFile(join(outputDirectory, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');
console.log(`Built runtime release assets for ${target} in ${outputDirectory}.`);

async function hashFile(filePath) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) {
		digest.update(chunk);
	}
	return digest.digest('hex');
}
