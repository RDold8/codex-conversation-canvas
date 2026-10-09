"""Package compiled plugin payload without dependencies, chat logs, or client changes."""
import hashlib
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
plugin = root / 'plugins' / 'long-conversation-canvas'
version = json.loads((plugin / 'package.json').read_text(encoding='utf-8'))['version']
manifest = json.loads((plugin / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
lock = json.loads((plugin / 'package-lock.json').read_text(encoding='utf-8'))
if not (version == manifest['version'] == lock['version'] == lock['packages']['']['version']):
    raise RuntimeError('Package, lock and plugin manifest versions must match before packaging.')
candidate = json.loads((root / 'evidence/release-candidate.json').read_text(encoding='utf-8'))
if candidate['status'] != 'PASS' or candidate['version'] != version:
    raise RuntimeError('Run prepare_release.py to verify this release before packaging.')
for name, digest in candidate['sha256'].items():
    if hashlib.sha256((plugin / name).read_bytes()).hexdigest() != digest:
        raise RuntimeError('Payload changed after candidate validation: ' + name)
payload = {}
for name in ['.codex-plugin/plugin.json', '.mcp.json', 'dist/server.mjs', 'dist/workspace.html']:
    payload['plugins/long-conversation-canvas/' + name] = (plugin / name).read_bytes()
for path in sorted((plugin / 'skills').rglob('*')):
    if path.is_file():
        payload['plugins/long-conversation-canvas/' + path.relative_to(plugin).as_posix()] = path.read_bytes()
for name in ['Install.ps1', 'README.md', 'THIRD_PARTY_NOTICES.txt']:
    payload[name] = (root / 'packaging' / name).read_bytes()
payload['.agents/plugins/marketplace.json'] = (root / '.agents/plugins/marketplace.json').read_bytes()
inventory = {'version': version, 'files': [
    {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    for name, data in sorted(payload.items())]}
payload['payload-sha256.json'] = (json.dumps(inventory, ensure_ascii=False, indent=2)+'\n').encode('utf-8')
delivery = root / 'delivery'
delivery.mkdir(exist_ok=True)
target = delivery / f'codex-long-tasks-embedded-{version}.zip'
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, data in sorted(payload.items()):
        archive.writestr(name, data)
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == set(payload)
    for entry in inventory['files']:
        assert hashlib.sha256(archive.read(entry['path'])).hexdigest() == entry['sha256']
report = {'zip': str(target), 'version': version, 'bytes': target.stat().st_size,
          'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'file_count': len(payload),
          'zip_roundtrip_verified': True, 'payload': inventory,
          'desktop_install_repeated': False, 'sidebar_acceptance': 'not_verified_for_this_bundle_install',
          'native_host_evidence': 'evidence/native-sidebar-task-acceptance.json'}
(root / 'evidence' / 'external-embed-bundle.json').write_text(
    json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({k: v for k, v in report.items() if k != 'payload'}, ensure_ascii=True))
