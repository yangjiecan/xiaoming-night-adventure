export const W=1280,H=720,GROUND=180,COLORS=['#f5cd73','#e8b2c9','#a4d6df'];
export const CUES={choose:'给小熊送一盏灯 · 点你喜欢的小灯',taking:'小铭走过去，把小灯拿稳……',dock:'灯拿好啦 · 点点前面的码头',walking:'小铭抱着灯，赛罗在后面陪着他',board:'小船准备好啦 · 点点小船',boarding:'慢慢上船，赛罗会陪着小铭',sail:'点点远处的小熊家，一起出发',sailing:'小灯要稳稳拿好，我们去小熊家',landing:'到岸啦，和伙伴一起下船',deliver:'小熊在门口等我们 · 点点小熊',giving:'小铭把灯递给小熊，小屋就要亮起来了',five:'小屋亮起来啦 · 点点赛罗的手，击个掌',celebrating:'啪！这盏暖暖的灯，是我们一起送来的',done:'晚安，小铭。小熊会记得这盏暖暖的小灯。'};
const smooth=t=>t*t*(3-2*t),lerp=(a,b,t)=>a+(b-a)*t;
export class Story{
 constructor(onEvent=()=>{}){this.onEvent=onEvent;this.reset();}
 emit(name){try{this.onEvent(name);}catch(e){this.eventErrors.push({event:name,message:String(e.message||e)});}}
 reset(){this.eventErrors=[];this.time=0;this.stage='choose';this.queue=[];this.active=null;this.selected=null;this.lampOwner='rack';this.lampBlend=0;this.glow=0;this.contact=0;this.camera=0;this.cameraGoal=0;this.boat={x:1230,y:155};this.onBoat=false;this.boy={x:280,y:GROUND,dir:1,pose:'idle',reach:0,speed:0,phase:0};this.zero={x:145,y:GROUND,dir:1,pose:'idle',reach:0,speed:0,phase:0};this.bear={x:2070,y:GROUND,dir:-1,pose:'idle',reach:0,speed:0,phase:0};this.stageHistory=['choose'];this.emit('reset');}
 get busy(){return !!this.active||this.queue.length>0;}
 setStage(stage,event){this.stage=stage;this.stageHistory.push(stage);if(event)this.emit(event);}
 step(duration,update=()=>{},end=()=>{},begin=()=>{}){return{duration,update,end,begin,time:0};}
 moving(actor,x,duration,y=GROUND){let sx,sy;return this.step(duration,t=>{const u=smooth(t);actor.x=lerp(sx,x,u);actor.y=lerp(sy,y,u);},()=>{actor.speed=0;},()=>{sx=actor.x;sy=actor.y;actor.dir=x>=sx?1:-1;});}
 together(x,duration){let bx,zx;return this.step(duration,t=>{const u=smooth(t);this.boy.x=lerp(bx,x,u);this.zero.x=lerp(zx,x-135,u);this.cameraGoal=Math.max(0,Math.min(1120,this.boy.x-430));},()=>{},()=>{bx=this.boy.x;zx=this.zero.x;});}
 sequence(...steps){this.queue.push(...steps);}
 input(id){
  if(this.busy)return false;
  if(this.stage==='choose'&&/^lamp-[012]$/.test(id)){
   this.selected=Number(id.slice(-1));const x=580+this.selected*85;this.setStage('taking','pick');
   this.sequence(this.together(x-65,2.3),this.step(.65,t=>{this.boy.pose='pick';this.boy.reach=t;}),this.step(.15,()=>{},()=>{this.lampOwner='boy';this.emit('take');}),this.step(.85,t=>{this.boy.reach=1-t;},()=>{this.boy.pose='carry';this.setStage('dock','dock');}));return true;
  }
  if(this.stage==='dock'&&id==='dock'){
   this.setStage('walking');this.sequence(this.together(1010,3.1),this.step(.2,()=>{},()=>this.setStage('board','board')));return true;
  }
  if(this.stage==='board'&&id==='boat'){
   this.setStage('boarding');let bx=this.boy.x,zx=this.zero.x;
   this.sequence(this.step(1.5,t=>{const u=smooth(t);this.boy.x=lerp(bx,1275,u);this.boy.y=GROUND+Math.sin(t*Math.PI)*18;this.zero.x=lerp(zx,1145,u);this.zero.y=GROUND+Math.sin(Math.max(0,t-.15)*Math.PI)*13;this.cameraGoal=lerp(this.cameraGoal,1060,.06);},()=>{this.onBoat=true;this.cameraGoal=1060;}),this.step(1,t=>{this.cameraGoal=1060;},()=>this.setStage('sail','sail')));return true;
  }
  if(this.stage==='sail'&&id==='home'){
   this.setStage('sailing','boat');this.sequence(this.step(6.3,t=>{this.boat.x=lerp(1230,1760,smooth(t));this.cameraGoal=lerp(1060,1120,smooth(t));}),this.step(.3,()=>{},()=>{this.onBoat=false;this.setStage('landing');}),this.step(1.4,t=>{this.boy.x=lerp(1805,1905,smooth(t));this.zero.x=lerp(1675,1770,smooth(t));this.boy.y=GROUND+Math.sin(t*Math.PI)*14;this.zero.y=GROUND+Math.sin(t*Math.PI)*10;},()=>{this.boy.y=this.zero.y=GROUND;this.setStage('deliver','deliver');}));return true;
  }
  if(this.stage==='deliver'&&id==='bear'){
   this.setStage('giving');this.sequence(this.moving(this.boy,1930,.65),this.step(.9,t=>{this.boy.pose='give';this.boy.reach=t;this.bear.pose='receive';this.bear.reach=t;}),this.step(.5,t=>{this.lampOwner='handover';this.lampBlend=t;},()=>{this.lampOwner='bear';this.boy.pose='idle';this.boy.reach=0;this.bear.pose='carry';this.emit('thanks');}),this.step(.4,()=>{},()=>{this.bear.dir=1;}),this.moving(this.bear,2150,1.1),this.step(.8,t=>{this.bear.pose='hang';this.bear.reach=t;}),this.step(1.2,t=>{this.lampOwner='window';this.glow=t;},()=>{this.bear.pose='wave';this.bear.dir=-1;this.boy.dir=-1;this.boy.pose='idle';this.setStage('five','five');}));return true;
  }
  if(this.stage==='five'&&id==='highfive'){
   this.setStage('celebrating');this.boy.dir=-1;this.zero.dir=1;
   this.sequence(this.step(.8,t=>{this.boy.pose=this.zero.pose='highfive';this.boy.reach=this.zero.reach=t;}),this.step(.15,()=>{this.contact=1;},()=>this.emit('clap')),this.step(.7,t=>{this.contact=1-t;}),this.step(.8,t=>{this.boy.reach=this.zero.reach=1-t;},()=>{this.boy.pose=this.zero.pose='idle';this.bear.pose='idle';this.setStage('done','done');}));return true;
  }
  return false;
 }
 update(dt){dt=Math.min(.1,Math.max(0,dt));this.time+=dt;const previous=[this.boy.x,this.zero.x,this.bear.x];
  if(!this.active&&this.queue.length){this.active=this.queue.shift();this.active.begin();}
  if(this.active){const q=this.active;q.time+=dt;const t=Math.min(1,q.time/q.duration);q.update(t);if(t===1){q.end();this.active=null;}}
  if(this.onBoat){const bob=Math.sin(this.time*2.2)*2;this.boy.x=this.boat.x+45;this.zero.x=this.boat.x-85;this.boy.y=GROUND+bob;this.zero.y=GROUND+bob;}
  for(const [i,actor]of [this.boy,this.zero,this.bear].entries()){const velocity=dt?Math.abs(actor.x-previous[i])/dt:0;actor.speed=this.onBoat&&i<2?0:velocity;if(actor.speed>2)actor.phase+=Math.abs(actor.x-previous[i])/(i===1?115:86)*Math.PI*2;}
  this.camera+= (this.cameraGoal-this.camera)*Math.min(1,dt*3);
 }
 targets(){if(this.busy)return[];const base=(id,x,y,w,h,label)=>({id,x,y,w,h,label});switch(this.stage){case'choose':return[0,1,2].map(i=>base('lamp-'+i,536+i*85,280,88,125,['暖黄灯','粉粉灯','浅蓝灯'][i]));case'dock':return[base('dock',925,165,210,125,'去码头')];case'board':return[base('boat',1075,105,335,165,'上小船')];case'sail':return[base('home',1980,180,350,380,'去小熊家')];case'deliver':return[base('bear',1985,180,170,240,'送给小熊')];case'five':return[base('highfive',1740,250,220,210,'击个掌')];default:return[];}}
 snapshot(){return{stage:this.stage,busy:this.busy,selected:this.selected,lampOwner:this.lampOwner,contact:this.contact,glow:this.glow,camera:this.camera,onBoat:this.onBoat,boat:{...this.boat},boy:{...this.boy},zero:{...this.zero},bear:{...this.bear},targets:this.targets(),stageHistory:this.stageHistory.slice(),eventErrors:this.eventErrors.slice(),time:this.time};}
}
