"""Render a narrated product walkthrough from actual public-page screenshots.
Requires Pillow, imageio-ffmpeg and WAV files made by narrate.ps1.
"""
import json, math, re, subprocess, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'output/video'; BUILD=OUT/'build'
BUILD.mkdir(parents=True,exist_ok=True)
scenes=json.loads((ROOT/'video/scenes.json').read_text())
FF=imageio_ffmpeg.get_ffmpeg_exe()
W,H=1920,1080
NAVY='#0b2c43'; PALE='#f1f7f9'; INK='#10344d'; CYAN='#57c5e0'; MUTED='#a8c8d8'
FONT=Path('C:/Windows/Fonts')
def font(size,bold=False): return ImageFont.truetype(str(FONT/('arialbd.ttf' if bold else 'arial.ttf')),size)
def words(draw,s,x,y,width,size=36,color='white',bold=False,gap=1.25):
    f=font(size,bold); lines=[]
    for paragraph in s.split('\n'):
        current=''
        for word in paragraph.split():
            trial=(current+' '+word).strip()
            if draw.textlength(trial,font=f)>width and current:
                lines.append(current); current=word
            else: current=trial
        lines.append(current)
    for line in lines:
        draw.text((x,y),line,font=f,fill=color); y+=int(size*gap)
    return y
logo=Image.open(ROOT/'public/branding/clearroute-icon.png').convert('RGBA')
screen=Image.open(ROOT/'pitch/assets/funding-desktop.png').convert('RGB')
def pastefit(canvas,im,box):
    x,y,w,h=box; im=im.copy(); im.thumbnail((w,h),Image.Resampling.LANCZOS)
    canvas.paste(im,(x+(w-im.width)//2,y+(h-im.height)//2),im if im.mode=='RGBA' else None)
def base(scene,i):
    im=Image.new('RGB',(W,H),NAVY); d=ImageDraw.Draw(im)
    pastefit(im,logo,(70,47,62,62)); words(d,'ClearRoute',151,57,350,34,bold=True)
    words(d,f'{i+1:02d} / 09',1710,60,140,24,CYAN)
    words(d,scene['label'],75,143,1760,23,CYAN,True)
    words(d,scene['title'],75,198,1750,58,'white',True)
    return im,d
durations=[]; srt=[]; offset=0.0; capidx=1
def stamp(t):
    ms=round(t*1000); h,ms=divmod(ms,3600000); m,ms=divmod(ms,60000); sec,ms=divmod(ms,1000)
    return f'{h:02}:{m:02}:{sec:02},{ms:03}'
for i,scene in enumerate(scenes):
    im,d=base(scene,i); v=scene['visual']
    if v=='cover':
        words(d,'Funding access for teams building on Canton',75,365,1030,80,'white',True)
        words(d,'A narrated Devnet product tour',80,688,1120,37,CYAN)
        words(d,'Live recipient transfer pending',80,763,1130,31,MUTED)
        pastefit(im,logo,(1360,365,420,420))
    elif v=='problem':
        for x,n,h,b in [(75,'01','Request CC','Give the operator a clear funding need.'),(700,'02','Review safely','Verify the wallet and control exposure.'),(1320,'03','Track delivery','Keep a record of the original transfer.')]:
            words(d,n,x,385,400,86,CYAN,True); words(d,h,x,520,500,40,'white',True); words(d,b,x,605,485,33,MUTED)
        words(d,'Wallet top-ups and validator traffic purchases are separate.',75,825,1700,31,CYAN)
    elif v=='desktop':
        pastefit(im,screen,(725,304,1120,585))
        words(d,'A public form\nfor builders',75,368,580,57,'white',True)
        words(d,'Team and contact\nFull wallet Party ID\nAmount and purpose',75,548,575,34,MUTED,gap=1.6)
        words(d,'Actual application screenshot',75,823,620,25,CYAN)
    elif v=='form':
        pastefit(im,screen.crop((715,122,1340,960)),(1180,296,680,604))
        words(d,'Use an onboarded\nDevnet wallet',75,350,1000,58,'white',True)
        words(d,'Provider: NODERS / Splice wallet\nRecipient: full wallet Party ID\nPlanned first request: 1 CC',75,558,1070,34,MUTED,gap=1.6)
        words(d,'A console-created party alone is not enough.',75,824,1075,29,CYAN)
    elif v=='review':
        words(d,'Demo transfers',75,346,960,62,'white',True)
        words(d,'Check treasury wallet\nVerify recipient ownership\nReview purpose and amount\nRecord approval',75,459,1030,38,MUTED,gap=1.6)
        words(d,'10 CC',1290,355,540,100,CYAN,True); words(d,'maximum per request',1290,494,540,30)
        words(d,'100 CC',1290,615,560,88,CYAN,True); words(d,'aggregate pilot exposure\nexcluding fees',1290,740,540,30)
    elif v=='delivery':
        stages=[('01','Send offer','One original tracking ID'),('02','Accept','Inside the recipient wallet'),('03','Reconcile','Check the original outcome')]
        for j,(num,head,body) in enumerate(stages):
            x=75+j*625; words(d,num,x,365,520,88,CYAN,True); words(d,head,x,512,550,48,'white',True); words(d,body,x,606,540,33,MUTED)
        words(d,'Illustrated workflow. No completed transfer is shown in this video.',75,825,1750,29,CYAN)
    elif v=='evidence':
        words(d,'CC delivered',75,365,1700,94,CYAN,True)
        words(d,'Wallet-reported transaction reference\nRecipient confirmation\nOriginal request and transfer history',75,540,1600,41,'white',gap=1.65)
        words(d,'Success criteria, not a claimed test result',75,824,1700,31,MUTED)
    elif v=='status':
        words(d,'134',75,353,600,148,CYAN,True)
        words(d,'tests passed',75,550,650,45,'white',True)
        words(d,'91 backend + 43 frontend\nTypeScript and build passed',75,650,700,31,MUTED,gap=1.6)
        words(d,'Wallet connection verified',865,380,970,45,'white',True)
        words(d,'Live recipient transfer: pending\nCustomer-page integration: separate\nAutomatic billing sync: not connected',865,503,960,33,MUTED,gap=1.8)
        words(d,'Free Devnet pilot. No invoice is created.',865,824,950,29,CYAN)
    elif v=='close':
        words(d,'Seeking a 1 CC\nDevnet test recipient',75,350,1340,77,'white',True)
        words(d,'An onboarded wallet that accepts Splice transfer offers',75,615,1670,38,CYAN)
        words(d,'Share your full wallet Party ID and provider. Never share credentials.',75,717,1660,31,MUTED)
        words(d,'github.com/deekshithreddy1/ClearRoute',75,822,1750,31,'white')
    # Stable caption band keeps subtitles readable while the image moves slightly.
    im.save(BUILD/f'scene-{i}.png')
    with wave.open(str(BUILD/f'voice-{i}.wav')) as a: speech=a.getnframes()/a.getframerate()
    duration=math.ceil((speech+1.0)*24)/24; durations.append(duration)
    # Sentence captions weighted by spoken length, over the narration interval.
    sentences=re.split(r'(?<=[.!?])\s+',scene['narration']); units=[]
    for sentence in sentences:
        ws=sentence.split()
        while ws: units.append(' '.join(ws[:17])); ws=ws[17:]
    total=sum(len(u.split()) for u in units); local=0.0; local_srt=[]
    for j,u in enumerate(units):
        length=speech*len(u.split())/total
        local_srt.append(f'{j+1}\n{stamp(local)} --> {stamp(local+length)}\n{u}\n')
        srt.append(f'{capidx}\n{stamp(offset+local)} --> {stamp(offset+local+length)}\n{u}\n'); capidx+=1; local+=length
    (BUILD/f'captions-{i}.srt').write_text('\n'.join(local_srt),encoding='utf-8')
    offset+=duration
    frames=round(duration*24)
    filters=f"zoompan=z='1+0.012*on/{frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={frames}:s=1920x1080:fps=24,drawbox=x=0:y=920:w=1920:h=160:color=0x061a29:t=fill,subtitles=captions-{i}.srt:force_style='FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00291A06,BorderStyle=1,Outline=1,Shadow=0,MarginV=4,Alignment=2',fade=t=in:st=0:d=0.25,fade=t=out:st={duration-.25}:d=0.25"
    args=[FF,'-hide_banner','-loglevel','error','-y','-i',f'scene-{i}.png','-i',f'voice-{i}.wav','-vf',filters,'-af',f'apad,atrim=duration={duration}', '-t',str(duration),'-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-threads','4','-c:a','aac','-b:a','160k','-ar','48000',f'part-{i}.mp4']
    subprocess.run(args,cwd=BUILD,check=True)
    print(f'Scene {i+1}/9 rendered ({duration:.1f}s)',flush=True)
(OUT/'clearroute-demo.srt').write_text('\n'.join(srt),encoding='utf-8')
(BUILD/'concat.txt').write_text('\n'.join(f"file 'part-{i}.mp4'" for i in range(len(scenes))))
subprocess.run([FF,'-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i','concat.txt','-c','copy','-movflags','+faststart',str(OUT/'clearroute-demo.mp4')],cwd=BUILD,check=True)
thumb=Image.new('RGB',(1920,1080),NAVY); dr=ImageDraw.Draw(thumb); pastefit(thumb,logo,(1300,270,440,440)); words(dr,'ClearRoute',95,130,1150,80,'white',True); words(dr,'CC FOR\nCANTON BUILDERS',95,325,1250,106,CYAN,True); words(dr,'DEVNET PRODUCT WALKTHROUGH',100,860,1700,38,'white',True); thumb.save(OUT/'clearroute-thumbnail.jpg',quality=95)
chapters=[]; elapsed=0
for scene,dur in zip(scenes,durations):
    chapters.append(f'{int(elapsed)//60}:{int(elapsed)%60:02} {scene["title"]}'); elapsed+=dur
description='''# Suggested YouTube title
ClearRoute Demo | Request Canton Coin for Your Devnet Wallet

# Description
ClearRoute is a CC funding application for Canton builders. This narrated product
walkthrough shows the actual public request page and explains operator review,
Splice transfer offers, recipient acceptance and delivery tracking.

Current status: sender wallet connection verified; the full volunteer-recipient
transfer is pending. No completed native CC transfer is shown. Public Devnet pilot
requests are free and remain separate from customer-account billing. Automatic
billing synchronization is not implemented.

Want to help test? Contact the person who shared this video with your full Devnet
wallet Party ID and wallet provider. Your wallet must accept Splice transfer offers.
Never share passwords, access tokens, private keys or recovery phrases.

Project: https://github.com/deekshithreddy1/ClearRoute
Contracts: https://github.com/deekshithreddy1/ClearRoute-DAML

Narration uses a synthetic Windows voice. Screenshots show the actual local public
page. Workflow graphics are explanatory, not recorded transfer evidence.

# Chapters
'''+ '\n'.join(chapters)+'''

# Upload
1. Open YouTube Studio in your own account and choose Create > Upload videos.
2. Select clearroute-demo.mp4. Paste the title and description above.
3. Upload clearroute-thumbnail.jpg as the thumbnail if the account permits it.
4. Review the audience and visibility settings. Use Unlisted for an initial review.
5. The video already includes visible captions. Optionally add clearroute-demo.srt
   as a subtitle track after reviewing its approximate timing.
6. Play the uploaded video once, then copy its share URL.

No public application URL is included because hosting is not yet established.
'''
(OUT/'YOUTUBE-UPLOAD.md').write_text(description,encoding='utf-8')
print(f'DONE: {elapsed:.1f}s, {OUT / "clearroute-demo.mp4"}',flush=True)

