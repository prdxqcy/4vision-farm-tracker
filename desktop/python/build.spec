# PyInstaller spec file for farmtracks-capture
# Run from the desktop/python directory:
#   pyinstaller build.spec --clean
#
# Output: desktop/python/dist/farmtracks-capture/farmtracks-capture.exe
# Copy that folder into desktop/python/dist/ so electron-builder can pick it up.

import os
block_cipher = None

a = Analysis(
    ['capture_worker.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        # Ship template images alongside the exe
        ('templates', 'templates'),
    ] + ([('capture_config.json', '.')] if os.path.isfile('capture_config.json') else []),
    hiddenimports=[
        'mss',
        'cv2',
        'numpy',
        'PIL',
        'pytesseract',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['easyocr', 'torch', 'torchvision'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='farmtracks-capture',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # must stay console so Electron can read stdout
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='farmtracks-capture',
)
