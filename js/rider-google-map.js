/* Google Maps renderer for the standalone Rider App. */
(() => {
  'use strict';
  const center={lat:9.4671,lng:125.5744};
  const authEvent='papalita:maps-auth-failure';
  const authMessage='Google Maps could not start. Ask Papalita support to check its Maps settings.';
  let libraries, authFailed=false;

  const point=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180
    ? {lat,lng} : null;

  window.gm_authFailure=()=>{
    authFailed=true;
    window.dispatchEvent(new Event(authEvent));
  };

  function loadLibraries(apiKey) {
    if(libraries)return libraries;
    libraries=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const callback='papalitaRiderGoogleMapsReady';
      let settled=false;
      const timeout=setTimeout(()=>finish(Error('Google Maps took too long to load. Reopen the map to retry.')),15000);
      function finish(error,api) {
        if(settled)return;
        settled=true;
        clearTimeout(timeout);
        window.removeEventListener(authEvent,onAuthFailure);
        delete window[callback];
        if(error){script.remove();reject(error);}
        else resolve(api);
      }
      const onAuthFailure=()=>finish(Error(authMessage));
      window.addEventListener(authEvent,onAuthFailure,{once:true});
      window[callback]=async()=>{
        try{
          const mapsApi=window.google.maps;
          const [maps,marker,core]=await Promise.all([
            mapsApi.importLibrary('maps'), mapsApi.importLibrary('marker'), mapsApi.importLibrary('core')
          ]);
          finish(null,{...maps,...marker,...core});
        }catch(error){finish(error);}
      };
      script.async=true;
      script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({
        key:apiKey, loading:'async', callback, v:'quarterly', region:'PH', auth_referrer_policy:'origin'
      });
      script.onerror=()=>finish(Error('Google Maps could not load. Check your connection and reopen the map.'));
      document.head.append(script);
    }).catch(error=>{libraries=undefined;throw error;});
    return libraries;
  }

  function create(container,onError) {
    const canvas=document.createElement('div');
    canvas.className='pr-google-map';
    const markers=new Set();
    let api,map,route,closed=false;
    function close() {
      if(closed)return;
      closed=true;
      window.removeEventListener(authEvent,onAuthFailure);
      for(const marker of markers)marker.map=null;
      markers.clear();
      route?.setMap(null);
      if(map)api.event.clearInstanceListeners(map);
      canvas.remove();
      route=map=null;
    }
    function fail(message) {
      if(closed)return;
      close();
      onError(message);
    }
    const onAuthFailure=()=>fail(authMessage);
    const ready=(async()=>{
      const apiKey=window.PAPALITA_RIDER_MAPS?.apiKey?.trim();
      const mapId=window.PAPALITA_RIDER_MAPS?.mapId?.trim();
      if(!apiKey||!mapId)throw Error('Google Maps is not configured for Papalita Rider yet.');
      if(authFailed)throw Error(authMessage);
      window.addEventListener(authEvent,onAuthFailure,{once:true});
      api=await loadLibraries(apiKey);
      if(closed||!container.isConnected)return false;
      container.append(canvas);
      map=new api.Map(canvas,{
        center,zoom:14,maxZoom:18,mapId,
        colorScheme:api.ColorScheme.DARK,
        disableDefaultUI:true,zoomControl:true,clickableIcons:false
      });
      return !closed;
    })().catch(error=>{fail(error.message||'Google Maps could not load.');return false;});

    return {
      ready,
      addMarker(position,title,element,options={}) {
        const marker=new api.AdvancedMarkerElement({position,title,anchorTop:'-50%',...options});
        marker.append(element);
        marker.map=map;
        markers.add(marker);
        return marker;
      },
      removeMarker(marker) {marker.map=null;markers.delete(marker);},
      fit(points,padding=40) {
        if(!map||!points.length)return;
        const [first]=points;
        if(points.every(p=>p.lat===first.lat&&p.lng===first.lng)){
          map.setCenter(first);
          map.setZoom(16);
        }else{
          const bounds=new api.LatLngBounds();
          points.forEach(p=>bounds.extend(p));
          map.fitBounds(bounds,padding);
        }
      },
      pan(position) {map?.panTo(position);},
      showRoute(path) {
        route?.setMap(null);
        route=new api.Polyline({map,path,strokeColor:'#2edd86',strokeOpacity:.95,strokeWeight:5});
      },
      clearRoute(){route?.setMap(null);route=null;},
      close
    };
  }

  window.PapalitaRiderGoogleMap={create,point};
})();
