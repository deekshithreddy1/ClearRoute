# ClearRoute product walkthrough video

Final outputs are in `../output/video/`:

- `clearroute-demo.mp4`: 1080p H.264/AAC video, 24 fps, synthetic narration and visible captions.
- `clearroute-demo.srt`: approximate sentence/phrase captions for optional YouTube subtitle upload.
- `clearroute-thumbnail.jpg`: YouTube thumbnail.
- `YOUTUBE-UPLOAD.md`: title, description, chapters and upload steps.

This is a narrated product walkthrough, not a recording of a completed transfer.
It uses actual public-page screenshots captured for the pitch and explanatory
workflow screens. It explicitly identifies recipient delivery as pending and
public pilot billing as separate. No wallets were funded to create this video.

To rebuild on Windows with Microsoft Zira Desktop installed:

```powershell
python -m pip install Pillow imageio-ffmpeg
powershell -NoProfile -ExecutionPolicy Bypass -File video/narrate.ps1
python video/build_video.py
```

Sources: `pitch/assets/`, `public/branding/`, the supplied successful verification
and treasury-check outputs, `backend/public-funding.ts`, `DEVNET-PILOT.md`.
Narration is in `scenes.json`. Temporary audio and rendering files stay ignored.
Caption timing is estimated from narration word counts and can be adjusted after
YouTube upload. The video needs no licensed music or external stock assets.
