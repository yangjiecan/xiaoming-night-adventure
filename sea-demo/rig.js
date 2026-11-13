const rad=Math.PI/180,lerp=(a,b,t)=>a+(b-a)*t;
export function sceneTools(cc){
 const color=(hex,alpha=255)=>{const n=parseInt(hex.replace('#',''),16);return new cc.Color(n>>16&255,n>>8&255,n&255,alpha);};
 const node=(name,parent,x=0,y=0)=>{const n=new cc.Node(name);n.layer=cc.Layers.Enum.UI_2D;n.addComponent(cc.UITransform).setContentSize(1,1);n.setPosition(x,y,0);parent.addChild(n);return n;};
 function sprite(name,parent,texture,rect,w,h,ax=.5,ay=1){const n=node(name,parent),s=n.addComponent(cc.Sprite),frame=new cc.SpriteFrame();frame.texture=texture;frame.rect=new cc.Rect(...rect);frame.originalSize=new cc.Size(rect[2],rect[3]);frame.offset=new cc.Vec2(0,0);s.sizeMode=cc.Sprite.SizeMode.CUSTOM;s.spriteFrame=frame;const ui=n.getComponent(cc.UITransform);ui.setAnchorPoint(ax,ay);ui.setContentSize(w,h);return{node:n,sprite:s,frame};}
 const graphics=(name,parent,draw)=>{const n=node(name,parent),g=n.addComponent(cc.Graphics);if(draw)draw(g);return{node:n,g};};
 const label=(name,parent,text,x,y,size=25,width=500)=>{const n=node(name,parent,x,y),l=n.addComponent(cc.Label);n.getComponent(cc.UITransform).setContentSize(width,size*1.8);l.string=text;l.fontSize=size;l.lineHeight=size*1.4;l.color=color('#344d69');l.overflow=cc.Label.Overflow.SHRINK;l.horizontalAlign=cc.Label.HorizontalAlign.CENTER;l.verticalAlign=cc.Label.VerticalAlign.CENTER;return{node:n,label:l};};
 return{cc,color,node,sprite,graphics,label};
}
const SPECS={xiaoming:{head:[93,96],body:[71,87],thigh:40,calf:43,legW:28,calfW:36,upper:31,lower:32,armW:23,lowerW:25,shoulder:28},zero:{head:[108,118],body:[94,110],thigh:52,calf:54,legW:35,calfW:49,upper:45,lower:43,armW:36,lowerW:36,shoulder:45},bear:{head:[98,96],body:[78,82],thigh:29,calf:32,legW:31,calfW:39,upper:27,lower:29,armW:29,lowerW:30,shoulder:29}};
function ik(x,y,l1,l2){const d=Math.max(1,Math.min(l1+l2-1,Math.hypot(x,y))),theta=Math.atan2(y,x),a=Math.acos(Math.max(-1,Math.min(1,(l1*l1+d*d-l2*l2)/(2*l1*d))));const angle=theta-a,ex=l1*Math.cos(angle),ey=l1*Math.sin(angle);return{a:angle/rad+90,b:(Math.atan2(y-ey,x-ex)-angle)/rad};}
export class Puppet{
 constructor(tools,parent,key,texture,atlas){this.T=tools;this.spec=SPECS[key];this.key=key;this.root=tools.node(key,parent);this.frontAngles={a:0,b:0};this.backAngles={a:0,b:0};this.weight=0;this.alpha=1;const s=this.spec;
  const part=(i,parent,w,h,ax=.5,ay=1)=>tools.sprite(key+'-'+i,parent,texture,atlas.parts[i],w,h,ax,ay);
  this.legs=[];for(const [thighIndex,calfIndex,x]of [[6,8,-s.body[0]*.21],[7,9,s.body[0]*.18]]){const hip=tools.node('hip',this.root,x,0),thigh=part(thighIndex,hip,s.legW,s.thigh+5),knee=tools.node('knee',hip,0,-s.thigh),calf=part(calfIndex,knee,s.calfW,s.calf+3);this.legs.push({hip,knee,thigh,calf});}
  const arm=(upperIndex,lowerIndex)=>{const shoulder=tools.node('shoulder',this.root),upper=part(upperIndex,shoulder,s.armW,s.upper+5),elbow=tools.node('elbow',shoulder,0,-s.upper),fore=part(lowerIndex,elbow,s.lowerW,s.lower+9),hand=part(10,elbow,s.lowerW*1.25,s.lowerW*1.35,.5,.15);hand.node.setPosition(0,-s.lower,0);hand.node.active=false;const plain=atlas.parts[lowerIndex].slice();plain[3]=Math.floor(plain[3]*.73);const sf=new tools.cc.SpriteFrame();sf.texture=texture;sf.rect=new tools.cc.Rect(...plain);sf.originalSize=new tools.cc.Size(plain[2],plain[3]);sf.offset=new tools.cc.Vec2(0,0);return{shoulder,elbow,upper,fore,hand,plain:sf,full:fore.frame};};
  this.back=arm(2,4);this.body=part(1,this.root,s.body[0],s.body[1],.5,0);this.head=part(0,this.root,s.head[0],s.head[1],.5,0);this.front=arm(3,5);this.hand={x:0,y:0};
 }
 update(a,dt){const s=this.spec;this.root.setPosition(a.x,a.y,0);this.root.setScale(a.dir,1,1);this.weight=lerp(this.weight,Math.min(1,a.speed/65),Math.min(1,dt*10));const walk=this.weight,p=a.phase;
  const legs=[0,Math.PI].map(offset=>({a:Math.sin(p+offset)*24*walk,b:-Math.max(0,Math.cos(p+offset))*32*walk}));let hips=0;for(const q of legs)hips=Math.max(hips,s.thigh*Math.cos(q.a*rad)+s.calf*Math.cos((q.a+q.b)*rad));this.hips=hips;
  this.legs.forEach((leg,i)=>{leg.hip.setPosition(i?s.body[0]*.18:-s.body[0]*.21,hips,0);leg.hip.angle=legs[i].a;leg.knee.angle=legs[i].b;});
  this.body.node.setPosition(0,hips-12,0);this.head.node.setPosition(1,hips+s.body[1]-17,0);this.head.node.angle=Math.sin(p)*1.4*walk;
  const sy=hips+s.body[1]-23;this.front.shoulder.setPosition(s.shoulder,sy,0);this.back.shoulder.setPosition(-s.shoulder*.88,sy-2,0);
  let front={a:-Math.sin(p)*22*walk,b:-8-8*walk},back={a:Math.sin(p)*22*walk,b:-8};let target=null,backTarget=null;
  if(['carry','pick','give','receive','hang'].includes(a.pose)){
   target=this.key==='bear'?{x:44,y:105}:{x:60,y:112};backTarget=this.key==='xiaoming'?{x:15,y:110}:null;
   if(a.pose==='pick')target={x:lerp(60,65,a.reach),y:lerp(112,200,a.reach)};
   if(a.pose==='give')target={x:lerp(60,76,a.reach),y:lerp(112,124,a.reach)};
   if(a.pose==='receive')target={x:lerp(35,62,a.reach),y:lerp(100,124,a.reach)};
   if(a.pose==='hang')target={x:lerp(44,40,a.reach),y:lerp(105,170,a.reach)};
  }
  if(a.pose==='highfive'){target=this.key==='xiaoming'?{x:lerp(s.shoulder,57,a.reach),y:lerp(sy-s.upper-s.lower,195,a.reach)}:{x:lerp(s.shoulder,103,a.reach),y:lerp(sy-s.upper-s.lower,195,a.reach)};}
  if(a.pose==='wave')target={x:s.shoulder+25,y:sy+28+Math.sin(p*2)*6};
  if(target)front=ik(target.x-s.shoulder,target.y-sy,s.upper,s.lower);if(backTarget)back=ik(backTarget.x+s.shoulder*.88,backTarget.y-sy+2,s.upper,s.lower);
  const speed=Math.min(1,dt*14);this.frontAngles={a:lerp(this.frontAngles.a,front.a,speed),b:lerp(this.frontAngles.b,front.b,speed)};this.backAngles={a:lerp(this.backAngles.a,back.a,speed),b:lerp(this.backAngles.b,back.b,speed)};
  for(const [arm,q]of [[this.front,this.frontAngles],[this.back,this.backAngles]]){arm.shoulder.angle=q.a;arm.elbow.angle=q.b;}
  const open=a.pose==='highfive'&&a.reach>.2||a.pose==='wave';this.front.hand.node.active=open;this.front.fore.sprite.spriteFrame=open?this.front.plain:this.front.full;this.front.hand.node.angle=-(this.frontAngles.a+this.frontAngles.b);
  const aa=this.frontAngles.a*rad,ab=(this.frontAngles.a+this.frontAngles.b)*rad;this.hand={x:a.x+a.dir*(s.shoulder+s.upper*Math.sin(aa)+s.lower*Math.sin(ab)),y:a.y+sy-s.upper*Math.cos(aa)-s.lower*Math.cos(ab)};
 }
}
