/* Rider street map and explicit road route lookup. */
(() => {
  'use strict';
  const {create:googleMap,point}=window.PapalitaRiderGoogleMap;
  let lastRouteRequest=0;

  function mount(dialog, order, onTheWay){
    const pickup=point(order.store_lat,order.store_lng);
    const drop=point(order.drop_lat,order.drop_lng);
    const target=onTheWay?drop:pickup;
    const status=dialog.querySelector('[data-map-status]');
    const locationButton=dialog.querySelector('[data-map-gps]');
    const routeButton=dialog.querySelector('[data-map-route]');
    const mapNode=dialog.querySelector('[data-map-canvas]');
    let riderMarker,current,watchId=null,request,closed=false,mapAvailable=false;
    const active=()=>dialog.open&&!closed&&dialog.isConnected;
    const missingPin=onTheWay?'The customer can set a drop-off pin in order tracking.':'A Papalita admin can save this store’s pickup pin.';
    const tell=message=>{status.textContent=message;};
    const map=googleMap(mapNode,message=>{
      if(!active())return;
      mapAvailable=false;
      stopWatch();
      request?.abort();
      locationButton.disabled=routeButton.disabled=true;
      tell(message+' Use Directions to open Google Maps.');
    });
    function stopWatch(){
      if(watchId!==null)navigator.geolocation.clearWatch(watchId);
      watchId=null;
    }
    function close(){
      if(closed)return;
      closed=true;
      stopWatch();
      request?.abort();
      document.removeEventListener('visibilitychange',pause);
      window.removeEventListener('pagehide',close);
      map.close();
    }
    function pause(){
      if(!document.hidden||watchId===null)return;
      stopWatch();
      if(riderMarker)map.removeMarker(riderMarker);
      riderMarker=null;
      current=null;
      request?.abort();
      map.clearRoute();
      routeButton.disabled=true;
      locationButton.textContent='Show my location';
      tell('GPS paused. Tap Show my location to resume.');
    }
    dialog.addEventListener('close',close,{once:true});
    document.addEventListener('visibilitychange',pause);
    window.addEventListener('pagehide',close,{once:true});
    function pin(position,kind,symbol,label) {
      const icon=document.createElement('div');
      icon.className='pr-map-pin '+kind;
      icon.innerHTML=symbol;
      return map.addMarker(position,label,icon);
    }
    map.ready.then(ready=>{
      if(!ready||!active())return;
      mapAvailable=true;
      if(pickup)pin(pickup,'pr-map-pickup','S','Store pickup');
      if(drop)pin(drop,'pr-map-drop','D','Customer drop-off');
      map.fit([pickup,drop].filter(Boolean),22);
      locationButton.disabled=false;
      tell(target?'Tap Show my location to find your live position.':missingPin);
    });

    locationButton.onclick=()=>{
      if(!mapAvailable)return;
      if(watchId!==null){if(current)map.pan(current);return;}
      if(!navigator.geolocation){tell('Location is unavailable on this device.');return;}
      tell('Waiting for your GPS location…');
      watchId=navigator.geolocation.watchPosition(({coords})=>{
        if(!active()||document.hidden)return;
        current=point(coords.latitude,coords.longitude);
        if(!current)return;
        if(riderMarker){riderMarker.position=current;return;}
        riderMarker=pin(current,'pr-map-rider','<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="m9 17 3-7h4l3 5M8 13h4M13 7h3l1 3"/></svg>','Your location');
        map.fit([current,target].filter(Boolean),24);
        routeButton.disabled=!target;
        locationButton.textContent='Center on me';
        tell(target?'Live location is on. Tap Show road route to calculate directions.':missingPin);
      },()=>{
        if(!active())return;
        stopWatch();
        tell('Your GPS position is unavailable. Check location permission and try again.');
      },{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
    };

    routeButton.onclick=async()=>{
      if(!active()||!mapAvailable||!current||!target||request)return;
      if(Date.now()-lastRouteRequest<2000)return;
      lastRouteRequest=Date.now();
      request=new AbortController();
      const timeout=setTimeout(()=>request?.abort(),12000);
      routeButton.disabled=true;
      tell('Finding a road route…');
      try{
        const endpoint=window.FOODIE_CONFIG?.maps?.riderRoute
          ||'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
        const coordinates=[current,target].map(({lat,lng})=>lng.toFixed(5)+','+lat.toFixed(5)).join(';');
        const result=await fetch(endpoint+coordinates+'?geometries=geojson&overview=simplified',{signal:request.signal});
        if(!result.ok)throw Error('Route lookup failed');
        const data=await result.json();
        if(!active()||!mapAvailable||document.hidden)return;
        const path=data.routes?.[0]?.geometry?.coordinates?.map(([lng,lat])=>point(lat,lng));
        if(data.code!=='Ok'||path?.length<2||!path?.every(Boolean))throw Error('No road route');
        map.showRoute(path);
        map.fit(path,25);
        tell('Road route ready. Your live pin continues moving as you travel.');
        routeButton.textContent='Update road route';
      }catch{
        if(active()&&mapAvailable&&!document.hidden)tell('Could not get a road route. Try again or open Google Maps for directions.');
      }finally{
        clearTimeout(timeout);
        request=null;
        if(active())routeButton.disabled=!mapAvailable||!current;
      }
    };
    return close;
  }

  window.PapalitaRiderMap={mount};
})();
