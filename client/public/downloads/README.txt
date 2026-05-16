Place the generated Windows installer here before deploying the web app:

Expected filename:
FarmTracks-Overlay-Setup.exe

You can generate it with:
npm run desktop:installer

If you host the installer somewhere else, set VITE_OVERLAY_INSTALLER_URL to that public URL before building the client.
