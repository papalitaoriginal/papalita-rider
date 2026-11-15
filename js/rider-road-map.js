/* Rider street map. GPS stays on the device until the rider requests a route. */
(() => {
  'use strict';
  const cdn='https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.1/dist/';
  const style='https://tiles.openfreemap.org/styles/fiord';
  let loading, lastRouteRequest=0;
  const point=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180
    ? [lng,lat] : null;

  function loadMapLibre(){
    if(loading)return loading;
    const css=Object.assign(document.createElement('link'),{
      rel:'stylesheet',href:cdn+'maplibre-gl.css',crossOrigin:'anonymous',
      integrity:'sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK'
    });
    const script=Object.assign(document.createElement('script'),{
      src:cdn+'maplibre-gl.js',crossOrigin:'anonymous',
      integrity:'sha384-nXMl9YiLoSG5KBPTFgvxVuIqQQcqIvo0bFrvoEaGJC6r7IibIzF1S36Zbf/sKBtL'
    });
    loading=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Map library timed out')),12000);
      Promise.all([css,script].map(node=>new Promise((done,fail)=>{
        node.onload=done;
        node.onerror=fail;
        document.head.append(node);
      }))).then(()=>{
        if(window.maplibregl?.Map)resolve(window.maplibregl);
        else reject(Error('Map library unavailable'));
      },reject).finally(()=>clearTimeout(timeout));
    }).catch(error=>{css.remove();script.remove();loading=null;throw error;});
    return loading;
  }

  function create(container,onStatus){
    let map,resize,closed=false,loadTimeout;
    let status='';
    const setStatus=message=>{
      if(!closed&&message!==status){status=message;onStatus(message);}
    };
    const canvas=document.createElement('div');
    canvas.className='pr-vector-map';
    const ready=loadMapLibre().then(api=>{
      if(closed||!container.isConnected)return null;
      container.append(canvas);
      map=new api.Map({
        container:canvas,style,center:[125.5744,9.4671],zoom:14,maxZoom:19,
        dragRotate:false,touchPitch:false
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new api.NavigationControl({showCompass:false}),'top-right');
      map.on('error',()=>setStatus('Some street map data could not load.'));
      loadTimeout=setTimeout(()=>setStatus('The street map is taking longer than expected.'),12000);
      map.on('idle',()=>{
        clearTimeout(loadTimeout);
        if(map.isStyleLoaded()&&map.areTilesLoaded())setStatus('');
      });
      if(typeof ResizeObserver==='function'){
        resize=new ResizeObserver(()=>map.resize());
        resize.observe(container);
      }
      return {map,api};
    }).catch(()=>{
      clearTimeout(loadTimeout);
      resize?.disconnect();
      map?.remove();
      map=null;
      canvas.remove();
      setStatus('The street map could not load on this device.');
      return null;
    });
    return {
      ready,
      close(){
        if(closed)return;
        closed=true;
        clearTimeout(loadTimeout);
        resize?.disconnect();
        map?.remove();
        canvas.remove();
      }
    };
  }

  function fit(map,api,places,padding=28,maxZoom=16){
    if(!places.length)return;
    const [first]=places;
    if(places.every(p=>p[0]===first[0]&&p[1]===first[1])){
      map.jumpTo({center:first,zoom:maxZoom});
      return;
    }
    const bounds=new api.LngLatBounds(first,first);
    places.forEach(point=>bounds.extend(point));
    const insets={top:padding,right:padding,bottom:Math.max(72,padding),left:padding};
    map.fitBounds(bounds,{padding:insets,maxZoom,animate:false});
  }

  function mount(dialog, order, onTheWay){
    const pickup=point(order.store_lat,order.store_lng);
    const drop=point(order.drop_lat,order.drop_lng);
    const target=onTheWay?drop:pickup;
    const status=dialog.querySelector('[data-map-status]');
    const locationButton=dialog.querySelector('[data-map-gps]');
    const routeButton=dialog.querySelector('[data-map-route]');
    const mapNode=dialog.querySelector('[data-map-canvas]');
    let map,api,riderMarker,current,watchId=null,request,closed=false,mapLoaded=false,mapNotice='',guidance='';
    const active=()=>dialog.open&&!closed&&dialog.isConnected;
    const missingPin=onTheWay?'The customer can set a drop-off pin in order tracking.':'A Papalita admin can save this store’s pickup pin.';
    const tell=message=>{guidance=message;status.textContent=mapNotice||guidance;};
    const updateRouteButton=()=>{routeButton.disabled=!mapLoaded||!current||!target||!!request;};
    const renderer=create(mapNode,message=>{
      mapNotice=message;
      status.textContent=message?message+' Use the directions link below if needed.':guidance;
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
      renderer.close();
    }
    function pause(){
      if(!document.hidden||watchId===null)return;
      stopWatch();
      riderMarker?.remove();
      riderMarker=null;
      current=null;
      routeButton.disabled=true;
      request?.abort();
      locationButton.textContent='Show my location';
      tell('GPS paused. Tap Show my location to resume.');
    }
    dialog.addEventListener('close',close,{once:true});
    document.addEventListener('visibilitychange',pause);
    window.addEventListener('pagehide',close,{once:true});
    function pin(position,kind,symbol,label){
      const element=document.createElement('div');
      element.className='pr-map-pin '+kind;
      element.title=label;
      element.innerHTML=symbol;
      return new api.Marker({element}).setLngLat(position).addTo(map);
    }
    renderer.ready.then(loaded=>{
      if(!active()||!loaded)return;
      ({map,api}=loaded);
      mapLoaded=map.loaded();
      if(!mapLoaded)map.once('load',()=>{mapLoaded=true;updateRouteButton();});
      if(pickup)pin(pickup,'pr-map-pickup','S','Store pickup');
      if(drop)pin(drop,'pr-map-drop','D','Customer drop-off');
      fit(map,api,[pickup,drop].filter(Boolean),24);
      locationButton.disabled=false;
      tell(target?'Tap Show my location to find your live position.':missingPin);
    });

    locationButton.onclick=()=>{
      if(!map)return;
      if(watchId!==null){if(current)map.panTo(current);return;}
      if(!navigator.geolocation){tell('Location is unavailable on this device.');return;}
      tell('Waiting for your GPS location…');
      watchId=navigator.geolocation.watchPosition(({coords})=>{
        if(!active()||document.hidden)return;
        current=point(coords.latitude,coords.longitude);
        if(!current)return;
        if(riderMarker){riderMarker.setLngLat(current);return;}
        riderMarker=pin(current,'pr-map-rider','<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="m9 17 3-7h4l3 5M8 13h4M13 7h3l1 3"/></svg>','Your location');
        fit(map,api,[current,target].filter(Boolean),24);
        updateRouteButton();
        locationButton.textContent='Center on me';
        tell(target?'Live location is on. Tap Show road route to calculate directions.':missingPin);
      },()=>{
        if(!active())return;
        stopWatch();
        tell('Your GPS position is unavailable. Check location permission and try again.');
      },{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
    };

    routeButton.onclick=async()=>{
      if(!active()||routeButton.disabled)return;
      if(Date.now()-lastRouteRequest<2000)return;
      lastRouteRequest=Date.now();
      request=new AbortController();
      const timeout=setTimeout(()=>request?.abort(),12000);
      updateRouteButton();
      tell('Finding a road route…');
      try{
        const endpoint=window.FOODIE_CONFIG?.maps?.riderRoute
          ||'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
        const coordinates=[current,target].map(pair=>pair.map(n=>n.toFixed(5)).join(',')).join(';');
        const result=await fetch(endpoint+coordinates+'?geometries=geojson&overview=simplified',{signal:request.signal});
        if(!result.ok)throw Error('Route lookup failed');
        const data=await result.json();
        if(!active()||document.hidden)return;
        const path=data.routes?.[0]?.geometry?.coordinates?.map(([lng,lat])=>point(lat,lng));
        if(data.code!=='Ok'||path?.length<2||!path?.every(Boolean))throw Error('No road route');
        const route={type:'Feature',properties:{},geometry:{type:'LineString',coordinates:path}};
        const source=map.getSource('papalita-rider-route');
        if(source)source.setData(route);
        else {
          map.addSource('papalita-rider-route',{type:'geojson',data:route});
          map.addLayer({
            id:'papalita-rider-route',type:'line',source:'papalita-rider-route',
            layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#32db8b','line-width':5}
          });
        }
        fit(map,api,path,25,17);
        tell('Road route ready. Your live pin continues moving as you travel.');
        routeButton.textContent='Update road route';
      }catch{
        if(active()&&!document.hidden)tell('Could not get a road route. Try again or open Google Maps for directions.');
      }finally{
        clearTimeout(timeout);
        request=null;
        if(active())updateRouteButton();
      }
    };
    return close;
  }

  window.PapalitaRiderMap={mount,create,fit,point};
})();
