(function(){
 const base=new URL('.',document.currentScript.src).href;
 async function startCocos(options={}){
  const cc=await System.import(base+'cc.js');window.cc=cc;
  const effects=await fetch(base+'builtin-effects.json').then(r=>{if(!r.ok)throw Error('内置材质载入失败');return r.json();});
  cc.game.onPostSubsystemInitDelegate.add(()=>{
   for(const data of effects){const effect=Object.assign(new cc.EffectAsset(),data);effect.onLoaded();if(data.name.startsWith('builtin-')){const alias=Object.assign(new cc.EffectAsset(),data,{name:'internal/'+data.name});alias.onLoaded();}}
   const material=(key,effectName,defines={})=>{const m=new cc.Material();m._uuid=key;m.initialize({effectName,defines});cc.builtinResMgr.addAsset(key,m);};
   material('ui-base-material','builtin-sprite',{USE_TEXTURE:false});
   material('ui-sprite-material','builtin-sprite',{USE_TEXTURE:true,CC_USE_EMBEDDED_ALPHA:false,IS_GRAY:false});
   material('ui-sprite-gray-material','builtin-sprite',{USE_TEXTURE:true,CC_USE_EMBEDDED_ALPHA:false,IS_GRAY:true});
   material('ui-sprite-alpha-sep-material','builtin-sprite',{USE_TEXTURE:true,CC_USE_EMBEDDED_ALPHA:true,IS_GRAY:false});
   material('ui-sprite-gray-alpha-sep-material','builtin-sprite',{USE_TEXTURE:true,CC_USE_EMBEDDED_ALPHA:true,IS_GRAY:true});
   material('ui-alpha-test-material','builtin-sprite',{USE_TEXTURE:true,USE_ALPHA_TEST:true});
   material('ui-graphics-material','builtin-graphics');
   material('default-clear-stencil','builtin-clear-stencil',{USE_TEXTURE:false});
   material('missing-effect-material','builtin-unlit',{USE_COLOR:true});material('missing-material','builtin-unlit',{USE_COLOR:true});
  });
  await cc.game.init({debugMode:cc.DebugMode.WARN,overrideSettings:{screen:{frameRate:60,orientation:'landscape',exactFitScreen:true},rendering:{renderMode:2,customPipeline:false},assets:{preloadBundles:[]},launch:{launchScene:''},splashScreen:{totalTime:0},profiling:{showFPS:false}}});
  const width=options.width||1280,height=options.height||720;
  cc.view.setDesignResolutionSize(width,height,cc.ResolutionPolicy.SHOW_ALL);cc.view.resizeWithBrowserSize(true);
  const scene=new cc.Scene('海湾送灯');const canvas=new cc.Node('Canvas');scene.addChild(canvas);canvas.layer=cc.Layers.Enum.UI_2D;
  canvas.addComponent(cc.UITransform).setContentSize(width,height);canvas.addComponent(cc.Canvas);
  const cameraNode=new cc.Node('Camera');scene.addChild(cameraNode);cameraNode.setPosition(0,0,1000);const camera=cameraNode.addComponent(cc.Camera);camera.projection=cc.Camera.ProjectionType.ORTHO;camera.orthoHeight=height/2;camera.clearFlags=cc.Camera.ClearFlag.SOLID_COLOR;camera.clearColor=options.clearColor||new cc.Color(190,210,223,255);camera.visibility=cc.Layers.Enum.UI_2D;
  canvas.getComponent(cc.Canvas).cameraComponent=camera;
  cc.director.runSceneImmediate(scene);cc.game.run();
  return {cc,scene,root:canvas,camera,width,height};
 }
 window.startCocos=startCocos;
})();
