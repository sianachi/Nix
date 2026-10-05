"""Validate smoke exports beyond a successful HTTP response."""
import json
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

kind, path = sys.argv[1:]
if kind == 'pdf':
    text = subprocess.check_output(['pdftotext', path, '-'], timeout=15).decode()
else:
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None or not archive.namelist():
            raise ValueError('Export archive is empty or corrupt')
        if kind == 'nix':
            json.loads(archive.read('manifest.json'))
        text = ''.join(ET.fromstring(archive.read('word/document.xml')).itertext()) if kind == 'docx' else None
if text is not None and 'Nix release smoke test' not in text:
    raise ValueError('Converted document is missing the imported text')
