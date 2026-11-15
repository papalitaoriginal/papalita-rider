/* Rider-only map presentation. The customer and checkout maps keep their own styles. */
(() => {
  'use strict';
  const riderIcon = `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
    <g stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 38h18l9-10h12l10 16-10 6H19z" fill="#15a653"/>
      <path d="M27 13c9-5 17 1 16 9l-5 3-4 8 9 7H32l-11-9z" fill="#0c8c47"/>
      <path d="M6 24h16v15H6z" fill="#21b45c"/>
      <circle cx="17" cy="49" r="10" fill="#142b26"/><circle cx="51" cy="49" r="10" fill="#142b26"/>
    </g>
    <g stroke="#173b2a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="17" cy="49" r="9" fill="#182b25"/><circle cx="51" cy="49" r="9" fill="#182b25"/>
      <circle cx="17" cy="49" r="4" fill="#e3e9e6"/><circle cx="51" cy="49" r="4" fill="#e3e9e6"/>
      <path d="M8 39h21l8-9h8l10 10-10 6H27l-9 3z" fill="#16a34a"/>
      <path d="M46 27l5 22m-8-22h5" fill="none"/>
      <rect x="6" y="24" width="17" height="15" rx="3" fill="#30c56b"/><path d="M7 29h15" fill="none"/>
      <path d="M30 23c-4 2-8 8-7 13l12 4 1 7h8l-3-13-7-3 2-6" fill="#149b52"/>
      <path d="M30 36l11 3 1 8h-8l-1-6-8-3z" fill="#243834"/>
      <path d="M32 25l8 4 7-2" fill="none"/>
      <circle cx="35" cy="18" r="8" fill="#18a653"/><path d="M35 17h9l-2 5h-5" fill="#d5f7ee"/>
    </g></svg>`;
  const {create:openMap,fit,point}=window.PapalitaRiderMap;

  function create(container, note) {
    const stops=[];
    let api,map,closed=false,selection,position,previousPosition,rider,motion;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    let requestedFit=true,mapNotice='',paintedStops='';
    const renderer=openMap(container,message=>{
      mapNotice=message;
      updateNote();
    });
    function updateNote() {
      const {pickup, drop, phase} = selection || {};
      note.textContent = mapNotice || (!selection ? '' :
        phase==='dispatch' ? [!pickup?'Pickup pin unavailable.':'',drop?'Drop-off pin marks the general area.':'Drop-off shown by area name.'].filter(Boolean).join(' ') :
        !pickup && !drop ? 'Waiting for pickup and drop-off pins.' :
        !pickup ? 'Pickup pin unavailable.' : !drop ? 'Drop-off pin unavailable.' : '');
      note.hidden = !note.textContent;
    }
    function paint() {
      if (!map) return;
      const {pickup, drop, phase} = selection || {};
      const stopKey = JSON.stringify([pickup, drop, phase]);
      if (stopKey !== paintedStops) {
        paintedStops = stopKey;
        stops.splice(0).forEach(marker=>marker.remove());
        for (const [coords, label, mark, color] of [
          [pickup, 'Pickup', 'P', 'pickup'], [drop, phase==='dispatch'?'Drop-off area':'Drop-off', 'D', 'drop']
        ]) {
          if (!coords) continue;
          const element=document.createElement('div');
          element.className='pr-trip-marker';
          element.title=label;
          const badge=document.createElement('b');
          badge.className=color;
          badge.textContent=mark;
          element.append(badge);
          stops.push(new api.Marker({element}).setLngLat(coords).addTo(map));
        }
      }
      if (position) {
        if (rider && position !== previousPosition) {
          cancelAnimationFrame(motion);
          if(reduced.matches)rider.setLngLat(position);
          else {
            const from=rider.getLngLat(), [lng,lat]=position, start=performance.now();
            const animate=now=>{
              const f=Math.min(1,(now-start)/550);
              rider.setLngLat([from.lng+(lng-from.lng)*f,from.lat+(lat-from.lat)*f]);
              if(f<1)motion=requestAnimationFrame(animate);
            };
            motion=requestAnimationFrame(animate);
          }
        }
        else if(!rider){
          const element=document.createElement('div');
          element.className='pr-trip-marker pr-trip-rider';
          element.title='Your location';
          element.innerHTML=riderIcon;
          rider=new api.Marker({element,offset:[0,-15]}).setLngLat(position).addTo(map);
        }
      } else if (rider) { cancelAnimationFrame(motion); rider.remove(); rider = null; }
      previousPosition=position;

      if (requestedFit) {
        const target = ['transit','arrived'].includes(phase) ? drop : pickup;
        const places = (target && position && phase !== 'offer' ? [position,target] : [pickup,drop,position]).filter(Boolean);
        fit(map,api,places,42);
        requestedFit = !places.length;
      }
    }
    renderer.ready.then(loaded=>{
      if(closed||!loaded)return;
      ({map,api}=loaded);
      paint();
    });
    return {
      ready:renderer.ready,
      show(order,phase) {
        const next = order ? {
          id:order.id, phase,
          pickup:point(order.pickup_lat,order.pickup_lng) || point(order.store_lat,order.store_lng),
          drop:phase==='dispatch'?point(order.area_lat,order.area_lng):point(order.drop_lat,order.drop_lng)
        } : undefined;
        if (JSON.stringify(selection) !== JSON.stringify(next)) requestedFit = true;
        selection = next;
        updateNote();
        paint();
      },
      gps(lat,lng) {
        const next=point(lat,lng);
        if(next && !position) requestedFit=true;
        position=next;
        paint();
      },
      close(){
        closed=true;
        cancelAnimationFrame(motion);
        stops.splice(0).forEach(marker=>marker.remove());
        rider?.remove();
        renderer.close();
      }
    };
  }
  window.PapalitaRiderTripMap={create};
})();
