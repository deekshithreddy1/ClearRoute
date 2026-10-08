"""Reproducible PDF pitch. Run from ClearRoute-app: python pitch/build_pitch.py."""
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/pdf/clearroute-pitch.pdf'
OUT.parent.mkdir(parents=True,exist_ok=True)
for name,filename in [('Arial','arial.ttf'),('ArialBold','arialbd.ttf')]:
    pdfmetrics.registerFont(TTFont(name,str(Path('C:/Windows/Fonts')/filename)))
W,H=1280,720
NAVY='#0B2C43'; CYAN='#42B3D1'; PALE='#F1F7F9'; INK='#10344D'; MUTED='#587180'; WHITE='#FFFFFF'
c=Canvas(str(OUT),pagesize=(W,H)); c.setTitle('ClearRoute - Funding the next Canton builder'); c.setAuthor('Deekshith Reddy / ClearRoute')
checks=[]
def text(s,x,y,w,size=24,color=INK,bold=False,maxh=200):
    style=ParagraphStyle('t',fontName='ArialBold' if bold else 'Arial',fontSize=size,leading=size*1.24,textColor=HexColor(color))
    p=Paragraph(s,style); _,h=p.wrap(w,maxh)
    assert h<=maxh, f'Text overflow {s[:60]}: {h}>{maxh}'
    assert y+h<=690, f'Bottom overflow {s[:50]}'
    p.drawOn(c,x,H-y-h); checks.append((page,s,x,y,w,h))
def image(path,x,y,w,h):
    im=ImageReader(str(path)); iw,ih=im.getSize(); scale=min(w/iw,h/ih)
    c.drawImage(im,x,H-y-ih*scale,width=iw*scale,height=ih*scale,mask='auto')
def line(x,y,w,color=CYAN):
    c.setStrokeColor(HexColor(color)); c.setLineWidth(1); c.line(x,H-y,x+w,H-y)
def rect(x,y,w,h,color):
    c.setFillColor(HexColor(color)); c.rect(x,H-y-h,w,h,stroke=0,fill=1)
def base(n,dark=False):
    global page; page=n
    rect(0,0,W,H,NAVY if dark else PALE)
    if dark:
        image(ROOT/'public/branding/clearroute-icon.png',58,35,37,37)
        text('ClearRoute',107,40,180,20,WHITE,True)
    else: image(ROOT/'public/branding/clearroute-wordmark.png',58,35,180,42)
    text(f'{n:02d}',1172,42,50,13,CYAN,True)
def title(kicker,heading,dark=False):
    text(kicker.upper(),60,105,1100,14,CYAN,True,maxh=20)
    text(heading,60,144,1150,40,WHITE if dark else INK,True,maxh=110)
def foot(s,dark=False): text(s,60,661,1135,11,'#A8C5D2' if dark else MUTED,maxh=28)
def end(): c.showPage()

base(1)
text('CC FUNDING FOR CANTON BUILDERS',60,135,700,16,CYAN,True)
text('Fund the next<br/>Canton builder.',60,205,690,64,INK,True,maxh=180)
text('A funding and billing layer that helps small teams get CC into their wallets and keep building.',64,415,625,26,maxh=110)
image(ROOT/'pitch/assets/funding-mobile.png',920,120,280,520)
text('Deekshith Reddy<br/>Founder',64,581,500,18,MUTED,maxh=55)
foot('Investor introduction / HackCanton Devnet pilot / October 2026')
end()

base(2,True); title('Problem','Funding operations interrupt product work',True)
text('A small Canton team needs more than a Party ID to start operating.',60,252,1040,28,WHITE,maxh=80)
for x,num,head,body in [(60,'01','Find CC','Source a starting balance and understand the correct network and wallet.'),(465,'02','Move it safely','Verify the recipient, track the offer and confirm acceptance.'),(870,'03','Account for it','Explain delivery, spending and the next funding requirement.')]:
    text(num,x,361,160,48,CYAN,True)
    text(head,x,437,330,26,WHITE,True,maxh=45)
    text(body,x,491,330,21,'#C6DCE5',maxh=110)
foot('Customer problem hypothesis based on the ClearRoute build and onboarding experience. Discovery interviews are the next validation step.',True); end()

base(3); title('Product','One public entry point for CC requests')
image(ROOT/'pitch/assets/funding-desktop.png',490,236,730,410)
text('Bring your party.<br/>Request funding.',60,261,390,34,INK,True,maxh=100)
text('The visitor supplies a team name, full Devnet Party ID, wallet, amount and intended use.',60,392,365,23,maxh=135)
text('A private tracking link follows the request. No customer account or private key is required for the pilot.',60,521,365,20,MUTED,maxh=112)
foot('Actual public funding screen captured from the running local application on 8 October 2026. No transfer was submitted for this capture.'); end()

base(4); title('Customer journey','A reviewed request becomes a wallet delivery')
stages=[('Request','Builder shares a full Party ID and compatible Devnet wallet.'),('Review','Operator checks recipient control and approves an amount.'),('Send offer','Treasury submits one tracked CC offer.'),('Accept','Recipient accepts in their own wallet.'),('Confirm','ClearRoute records the wallet-reported outcome and reference.')]
for i,(head,body) in enumerate(stages):
    x=60+i*240; text(f'{i+1:02d}',x,270,170,46,CYAN,True); line(x,342,200); text(head,x,369,210,25,INK,True,maxh=36); text(body,x,430,203,21,maxh=145)
text('Recipient requirement',60,588,255,20,INK,True,maxh=30)
text('A Devnet wallet that supports Splice transfer offers. Operating a personal validator is not a prerequisite of this pilot.',330,586,880,20,MUTED,maxh=60)
foot('Source: DEVNET-PILOT.md. CC delivery does not itself buy validator traffic.'); end()

base(5,True); title('Product scope','CC top-ups first. Managed sponsorship next.',True)
text('Controlled top-up',60,282,525,32,WHITE,True,maxh=50)
text('The pilot implements CC transfer offers from a NODERS treasury to compatible recipient wallets.',60,352,510,25,'#C6DCE5',maxh=110)
text('Manual review, bounded requests and reconciliation give the operator control over each delivery.',60,489,510,22,'#C6DCE5',maxh=110)
text('Managed funding',715,282,500,32,CYAN,True,maxh=50)
text('Service agreement, allowance and sample-job workflows have confirmed Devnet ledger records.',715,352,485,25,WHITE,maxh=115)
text('Future traffic sponsorship needs a verified connector and usage attribution. Pilot top-ups remain separate from USD invoices.',715,489,485,22,'#C6DCE5',maxh=115)
foot('Sources: user-provided Devnet journal, 7 October 2026; DEVNET-PILOT.md. Production sponsorship remains a roadmap item.',True); end()

base(6); title('Evidence','Engineering progress with explicit pilot limits')
for x,value,label,detail in [(60,'134','Recorded passing tests','91 backend + 43 frontend'),(477,'5','Confirmed workflow steps','Offer, accept, allowance, job, complete'),(894,'2','Devnet service parties','Provider and first customer')]:
    text(value,x,269,320,70,CYAN,True,maxh=100); text(label,x,383,325,25,INK,True,maxh=70); text(detail,x,458,318,20,MUTED,maxh=85)
line(60,558,1160)
text('Pilot controls',60,586,230,21,INK,True,maxh=30)
text('10 CC per request / 100 CC aggregate exposure, excluding fees',315,586,880,23,maxh=65)
foot('Tests: verification-final.log, prior recorded run. Workflow: supplied Devnet journal. Limits: DEVNET-PILOT.md. These are not revenue or customer traction metrics.'); end()

base(7); title('Business model','Recurring fees plus a margin on funded usage')
text('$50',60,270,360,66,CYAN,True,maxh=100); text('proposed monthly platform fee',60,369,480,25,maxh=70)
text('5-10%',690,270,450,66,CYAN,True,maxh=100); text('proposed margin on sponsored usage',690,369,500,25,maxh=70)
line(60,480,1160)
text('Illustrative customer economics',60,509,520,26,INK,True,maxh=45)
text('$1,000 monthly usage x 7% margin + $50 fee = $120 gross monthly service revenue',60,564,1110,27,maxh=80)
foot('Pricing hypothesis, not launched commercial terms or a forecast. Gross service revenue excludes funded principal and precedes operating, wallet, credit and capital costs.'); end()

base(8); title('Go to market','Start with teams building their first Canton app')
text('Initial customer',60,278,350,27,INK,True,maxh=45)
text('Hackathon teams and small startups that need repeatable CC access but lack dedicated treasury operations.',60,348,350,24,maxh=165)
text('Acquisition',468,278,330,27,INK,True,maxh=45)
text('Invite builders through the funding page. Work with ecosystem mentors and hosted participant providers.',468,348,330,24,maxh=165)
text('Expansion',875,278,335,27,INK,True,maxh=45)
text('Use repeat funding requests to identify teams ready for paid service agreements and spending limits.',875,348,335,24,maxh=165)
text('Validate before scaling',60,572,335,22,CYAN,True,maxh=34)
text('Measure time to accepted delivery, repeat requests, support effort and willingness to pay.',430,570,770,23,maxh=62)
foot('Proposed acquisition and validation plan. No signed partnerships, paying-customer count or market-size estimate is claimed.'); end()

base(9,True); title('Why ClearRoute','The opportunity is funding operations',True)
text('Wallet infrastructure',60,280,475,29,WHITE,True,maxh=45)
text('Holds CC and executes transfers. ClearRoute uses that infrastructure through its connector.',60,350,475,25,'#C6DCE5',maxh=140)
text('ClearRoute',700,280,500,29,CYAN,True,maxh=45)
text('Adds a public request, approval policy, customer context and a record that connects the funding decision to its outcome.',700,350,485,25,WHITE,maxh=160)
text('Potential long-term advantage',60,546,530,23,CYAN,True,maxh=38)
text('A repeatable operating workflow and integrations that teams can keep using as their funding needs grow.',60,592,1125,23,'#C6DCE5',maxh=62)
foot('Positioning hypothesis. The connector currently targets NODERS Devnet and compatible Splice transfer offers.',True); end()

base(10); title('Roadmap','Earn reliability before expanding the network')
for x,phase,head,body in [(60,'NEXT DEMO','Prove real receipt','Finish a volunteer transfer with recipient acceptance and a wallet-confirmed transaction reference.'),(465,'HOSTED PILOT','Operate continuously','Deploy HTTPS with persistent storage. Verify credential renewal, restore procedures and monitoring.'),(870,'COMMERCIAL','Validate paid funding','Confirm demand and unit economics. Add production connectors, treasury policies and jurisdiction-specific review.')]:
    text(phase,x,274,325,15,CYAN,True,maxh=25); text(head,x,327,335,29,INK,True,maxh=85); text(body,x,431,330,23,maxh=165)
foot('Milestones, not completion claims. Future private institutional sponsorship requires a validated privacy and funding design.'); end()

base(11); title('Founder and ask','Help the next Canton team start building')
text('Deekshith Reddy',60,270,620,42,INK,True,maxh=65)
text('Founder, ClearRoute',60,338,570,24,MUTED,maxh=40)
text('Seeking pilot builders and ecosystem partners to validate reliable CC delivery and recurring demand.',60,422,655,29,maxh=150)
text('Near-term goal',865,277,345,23,CYAN,True,maxh=38)
text('One complete external-wallet demo, followed by a hosted pilot with repeat users.',865,341,345,27,maxh=165)
text('github.com/deekshithreddy1/ClearRoute',60,597,1120,22,CYAN,maxh=40)
foot('Capital requirements and fundraising terms have not been set. This introduction seeks pilot participation and feedback.'); end()

base(12); title('Appendix','Evidence and assumptions')
items=[('Product and limits','DEVNET-PILOT.md and backend/public-funding.ts document Devnet scope, transfer offers and 10 / 100 CC limits.'),('Product screenshots','Actual public /funding page captured locally on 8 October 2026. The two views show the same product at desktop and narrow widths.'),('Engineering evidence','verification-final.log records 91 backend and 43 frontend passing tests plus a production build. This deck does not rerun or certify production operation.'),('Ledger evidence','User-supplied 7 October Devnet journal reports confirmed offer, accept, allowance, job and completion steps. These are service records, not proof of native CC delivery.'),('Economics and roadmap','The user proposed a $50 monthly fee and 5-10% margin. The $120 example is arithmetic at a 7% margin. Acquisition, partnerships and commercial milestones are proposals.')]
for i,(head,body) in enumerate(items):
    y=259+i*75; text(head,60,y,240,19,INK,True,maxh=60); text(body,320,y,875,18,MUTED,maxh=65)
foot('Prepared from repository materials and the supplied project conversation. No external market-size or fundraising traction claims.'); end()
c.save()
print(f'{OUT}\n12 slides; {len(checks)} text blocks checked for height and page bounds')
