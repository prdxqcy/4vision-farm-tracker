# PyInstaller spec file for farmtracks-capture
# Run from the desktop/python directory:
#   pyinstaller build.spec --clean -y
#
# Output: desktop/python/dist/farmtracks-capture/farmtracks-capture.exe

from PyInstaller.utils.hooks import collect_all

block_cipher = None

rapidocr_datas, rapidocr_binaries, rapidocr_hiddenimports = collect_all("rapidocr_onnxruntime")

a = Analysis(
    ['capture_worker.py'],
    pathex=['.'],
    binaries=rapidocr_binaries,
    datas=rapidocr_datas,
    hiddenimports=[
        'mss',
        'numpy',
        'PIL',
    ] + rapidocr_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['cv2', 'pytesseract', 'easyocr', 'torch', 'torchvision'],
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
    console=True,
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
