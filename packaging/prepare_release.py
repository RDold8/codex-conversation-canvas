"""Build and verify a candidate before publishing the plugin manifest version."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugins/long-conversation-canvas'
FILES = ['package.json', 'package-lock.json', '.codex-plugin/plugin.json',
         '.mcp.json', 'dist/server.mjs', 'dist/workspace.html']

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def hashes():
    return {name: hashlib.sha256((PLUGIN / name).read_bytes()).hexdigest() for name in FILES}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
        parser.error('Expected a numeric semantic version.')
    manifest_path = PLUGIN / '.codex-plugin/plugin.json'
    manifest = read(manifest_path)
    if tuple(map(int,args.version.split('.'))) <= tuple(map(int,manifest['version'].split('.'))):
        parser.error('Use a newer version; do not republish changed payload under a cached version.')
    old_version = manifest['version']
    package = read(PLUGIN / 'package.json')
    lock = read(PLUGIN / 'package-lock.json')
    package['version'] = lock['version'] = lock['packages']['']['version'] = args.version
    write(PLUGIN / 'package.json', package)
    write(PLUGIN / 'package-lock.json', lock)
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    node = shutil.which('node')
    if not npm or not node:
        raise RuntimeError('Node and npm are required; manifest remains unpublished.')
    for command, cwd in [([npm, 'run', 'check'], PLUGIN), ([npm, 'run', 'build'], PLUGIN)]:
        subprocess.run(command, cwd=cwd, check=True)
        if read(manifest_path) != manifest:
            raise RuntimeError('Manifest changed during candidate validation; refusing to overwrite.')
    before = hashes()
    subprocess.run([node, str(ROOT / 'packaging/test_release_candidate.mjs')], cwd=ROOT, check=True)
    if hashes() != before or read(manifest_path) != manifest:
        raise RuntimeError('Candidate changed during runtime validation; refusing to publish.')
    candidate = read(ROOT / 'runtime/release-candidate-check.json')
    if candidate['status'] != 'PASS' or candidate['version'] != args.version:
        raise RuntimeError('Candidate check does not match this release.')
    manifest['version'] = args.version
    temporary = manifest_path.with_suffix('.json.pending')
    write(temporary, manifest)
    # All executable assets are complete before the host can discover the new version.
    os.replace(temporary, manifest_path)
    report = {'status':'PASS', 'version':args.version, 'previous_manifest_version':old_version,
              'publication_order':'check -> build -> isolated MCP probe -> manifest version',
              'candidate':candidate, 'sha256':hashes(), 'desktop_loaded':False}
    for name, digest in before.items():
        if name != '.codex-plugin/plugin.json' and report['sha256'][name] != digest:
            raise RuntimeError('Payload changed during manifest publication: ' + name)
    write(ROOT / 'evidence/release-candidate.json', report)
    print(json.dumps({'status':'PASS','published_manifest_version':args.version,'desktop_loaded':False}))

if __name__ == '__main__':
    main()
