/* Assigned deliveries and explicit, foreground GPS sharing. */
(() => {
  'use strict';
  const reasons = [
    ['store_delay','Store delay'], ['customer_unreachable','Customer unavailable'],
    ['wrong_address','Wrong address'], ['vehicle_issue','Vehicle issue'], ['other','Other']
  ];
  const labels = {
    offer:'Accept delivery', pickup:'I’m at the store', store:'Confirm pickup',
    transit:'I’ve arrived', arrived:'Confirm drop-off'
  };
  const money = amount => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(amount);
  const address = value => String(value || '').replace(/^.*? — /,'').trim();
  const phase = o => o.trip_delivered_at ? 'delivered' : o.trip_arrived_at ? 'arrived' :
    o.trip_picked_up_at || o.rider_picked_up_at ? 'transit' : o.trip_at_store_at ? 'store' :
    o.trip_accepted_at || o.rider_accepted_at ? 'pickup' : 'offer';

  function directions(place,lat,lng) {
    const coordinates = Number.isFinite(lat) && Number.isFinite(lng);
    if (!coordinates && !place) return '';
    const destination = coordinates ? lat+','+lng : place + (/Surigao del Norte/i.test(place)
      ? '' : (/Alegria/i.test(place)?', Surigao del Norte':', Alegria, Surigao del Norte'));
    return 'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(destination);
  }

  async function photoData(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>12*1024*1024) {
      throw Error('Choose a JPEG, PNG or WebP photo under 12 MB.');
    }
    const image = await createImageBitmap(file);
    try {
      const canvas=document.createElement('canvas');
      const scale=Math.min(1,960/Math.max(image.width,image.height));
      canvas.width=Math.max(1,Math.round(image.width*scale));
      canvas.height=Math.max(1,Math.round(image.height*scale));
      const ctx=canvas.getContext('2d',{alpha:false});
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      for(const quality of [.75,.55,.35]) {
        const encoded=canvas.toDataURL('image/jpeg',quality).split(',')[1];
        if(encoded && encoded.length<=340000)return encoded;
      }
      throw Error('The photo is too large. Choose a smaller photo.');
    } finally { image.close(); }
  }

  function open(dialog, db, isCurrent, esc, assignedOrder) {
    const list=dialog.querySelector('[data-live-jobs]');
    const info=dialog.querySelector('[data-live-info]');
    const footer=dialog.querySelector('[data-trip-controls]');
    const map=window.PapalitaRiderTripMap.create(dialog.querySelector('[data-trip-map]'),dialog.querySelector('[data-trip-map-note]'));
    let order=assignedOrder, painted='', share=null, refreshing=false, busy=false, loaded=false;
    let form='', photo='', photoLoading=false, revision=0, mutation=0, gpsWatch, reportId;
    const alive=()=>dialog.open && dialog.isConnected && isCurrent();
    const gcash=document.createElement('details');
    gcash.className='pr-trip-gcash';
    gcash.innerHTML=`<summary>Show GCash QR</summary>
      <div class="pr-trip-gcash-body">
        <p>Ask the customer to pay <strong data-gcash-amount></strong>.</p>
        <p data-gcash-status role="status"></p>
        <div class="pr-trip-gcash-frame" hidden>
          <img data-gcash-image alt="Papalita GCash payment QR">
        </div>
        <button type="button" class="btn s" data-gcash-view hidden>Show full GCash card</button>
        <p>Check that the customer has sent the amount, then request verification.</p>
        <button type="button" class="btn p" data-trip-action="verify-gcash" disabled>Request GCash verification</button>
      </div>`;
    const gcashAmount=gcash.querySelector('[data-gcash-amount]');
    const gcashStatus=gcash.querySelector('[data-gcash-status]');
    const gcashImage=gcash.querySelector('[data-gcash-image]');
    const gcashFrame=gcashImage.parentElement;
    const gcashView=gcash.querySelector('[data-gcash-view]');
    const requestGcash=gcash.querySelector('[data-trip-action="verify-gcash"]');
    let gcashUrl='',loadingGcash=false;
    function focusGcashCode(focused) {
      gcashFrame.classList.toggle('is-focused',focused);
      gcashView.textContent=focused?'Show full GCash card':'Enlarge QR code';
    }
    gcashView.addEventListener('click',()=>focusGcashCode(!gcashFrame.classList.contains('is-focused')));
    gcashImage.addEventListener('load',()=>{
      // The supplied GCash card has a large border around the scan area.
      const canFocus=gcashImage.naturalWidth===781&&gcashImage.naturalHeight===1536;
      focusGcashCode(canFocus);
      gcashFrame.hidden=false;
      gcashView.hidden=!canFocus;
      requestGcash.disabled=busy;
      gcashStatus.textContent='';
    });
    function clearGcashImage() {
      if(gcashUrl)URL.revokeObjectURL(gcashUrl);
      gcashUrl='';
      gcashImage.removeAttribute('src');
      gcashFrame.hidden=true;
      gcashView.hidden=true;
      requestGcash.disabled=true;
    }
    gcashImage.addEventListener('error',()=>{
      clearGcashImage();
      gcashStatus.textContent='GCash QR could not be displayed. Contact Papalita support.';
    });
    gcash.addEventListener('toggle',async()=>{
      if(!gcash.open||!gcash.isConnected||!alive()||loadingGcash||gcashUrl)return;
      loadingGcash=true;
      gcashStatus.textContent='Loading GCash QR…';
      try {
        const {data,error}=await db.storage.from('papalita-rider-payments').download('gcash-qr.png');
        if(!gcash.isConnected||!alive())return;
        if(error||!data?.size||data.type!=='image/png')throw Error('QR not available');
        gcashUrl=URL.createObjectURL(data);
        gcashImage.src=gcashUrl;
      } catch {
        if(gcash.isConnected&&alive())gcashStatus.textContent='GCash QR is unavailable. Contact Papalita support.';
      } finally {loadingGcash=false;}
    });
    const tell=message=>{info.textContent=message;info.hidden=!message;};
    const rpc=async(name,args)=>{
      const {data,error}=await db.rpc(name,args);
      if (error) throw Object.assign(Error(error.message || 'Could not connect.'),{code:error.code});
      return data;
    };
    const link=(url,text)=>url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+text+'</a>':'';
    function stop(label, title, detail, url, eta) {
      return `<div class="pr-trip-stop"><span>${label==='Pickup'?'P':'D'}</span><div>
        <small>${label}${Number.isFinite(eta)&&eta>0?' · '+Math.ceil(eta)+' min':''}</small>
        <h3>${esc(title)}</h3><p>${esc(detail)}</p>${link(url,'Directions')}</div></div>`;
    }
    function clearForm() {form='';photo='';photoLoading=false;reportId=undefined;revision++;}
    function paint() {
      const o=order, step=o?phase(o):'';
      map.show(o,step);
      const signature=JSON.stringify([o,form,!!photo,photoLoading,share?.id,busy,loaded]);
      if(painted===signature)return;
      painted=signature;
      const q=o?.delivery_pricing;
      const payout=Number.isFinite(q?.total_centavos)?money(q.total_centavos/100):
        o?.delivery_fee!=null&&Number.isFinite(Number(o.delivery_fee))?money(Number(o.delivery_fee)):'Unavailable';
      const due=o?.payment_method==='cod'&&!['paid','refunded'].includes(o.payment_status)&&o.total_amount!=null&&Number.isFinite(Number(o.total_amount));
      const waitingForGcash=o?.cod_payment_state==='gcash_pending';
      const showGcash=due&&!waitingForGcash&&o.payment_status==='unpaid'&&o.status==='out_for_delivery'&&loaded&&step==='arrived'&&Number(o.total_amount)>0;
      const customerPhone=String(o?.contact_number||'').replace(/[^0-9+]/g,'');
      const storeCoords=[o?.pickup_lat??o?.store_lat,o?.pickup_lng??o?.store_lng];
      const hasPhoto=form==='pickup-photo'||form==='proof';
      const previousDraft=list.querySelector('textarea')?.value||'';
      const reportReason=list.querySelector('[name=reason]')?.value || (['transit','arrived'].includes(step)?'customer_unreachable':'store_delay');
      const focus=list.contains(document.activeElement)?document.activeElement.getAttribute('data-trip-action'):null;
      list.innerHTML=o?`<section aria-label="Order ${esc(o.id.slice(0,8))}">
        ${step==='delivered'?'<p role="status">Delivery completed. See Earnings for your delivery history.</p>':''}
        <div class="pr-trip-pay"><span>${due&&step==='arrived'?(showGcash?'Amount due':'Cash to collect'):'Delivery payout'}</span><strong>${due&&step==='arrived'?money(Number(o.total_amount)):payout}</strong><span>Order #${esc(o.id.slice(0,8))}</span></div>
        ${waitingForGcash?'<p class="pr-trip-gcash-state" role="status">GCash payment awaiting Papalita verification.</p>':''}
        ${step==='arrived'&&o.cod_payment_state==='gcash_verified'?'<p class="pr-trip-gcash-state" role="status">GCash payment verified by Papalita.</p>':''}
        ${step==='arrived'&&o.cod_payment_state==='gcash_cancelled'?'<p class="pr-trip-gcash-state" role="status">Papalita closed the GCash request. Ask the customer how they want to pay.</p>':''}
        ${showGcash?'<div data-gcash-slot></div>':''}
        ${stop('Pickup',o.store||'Store',o.store_address||'Pickup address unavailable',directions([o.store,o.store_address].filter(Boolean).join(', '),...storeCoords),o.pickup_eta_minutes)}
        ${stop('Drop-off',step==='offer'?'Customer drop-off':o.customer_name||'Customer drop-off',address(o.address)||'Drop-off address unavailable',directions(address(o.address),o.drop_lat,o.drop_lng),o.drop_eta_minutes)}
        ${step!=='offer'&&customerPhone?`<div class="pr-trip-links"><a href="tel:${esc(customerPhone)}">Call customer</a><a href="sms:${esc(customerPhone)}">Text customer</a></div>`:''}
        <div class="pr-trip-tools">
          ${['transit','arrived'].includes(step)&&o.status==='out_for_delivery'?`<button type="button" class="btn s" data-trip-action="gps" ${busy||share&&share.id!==o.id?'disabled':''}>${share?.id===o.id?'Stop sharing GPS':'Share live GPS'}</button>`:''}
          ${loaded&&!['offer','delivered'].includes(step)?`<button type="button" class="btn s" data-trip-action="report" ${busy?'disabled':''}>${['transit','arrived'].includes(step)?'Customer unavailable / Report an issue':'Report an issue'}</button>`:''}
          ${step==='store'?`<button type="button" class="btn s" data-trip-action="pickup-photo" ${busy?'disabled':''}>${o.trip_pickup_photo?'Replace pickup photo':'Add pickup photo'}</button>`:''}
          ${step==='arrived'?`<button type="button" class="btn s" data-trip-action="proof" ${busy?'disabled':''}>${o.trip_proof?'Replace proof photo':'Add proof photo'}</button>`:''}
          ${form==='report'?`<form aria-label="Report delivery issue"><label>Reason <select name="reason" class="pr-trip-select">${reasons.map(([value,name])=>`<option value="${value}" ${value===reportReason?'selected':''}>${name}</option>`).join('')}</select></label><label>Note (optional)<textarea name="note" maxlength="240"></textarea></label><button class="btn p" ${busy?'disabled':''}>Send report</button></form>`:''}
          ${hasPhoto?`<form aria-label="Attach delivery photo"><label>Delivery photo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" ${busy?'disabled':''}></label>${photo?`<img class="pr-trip-photo" alt="Photo preview" src="data:image/jpeg;base64,${photo}">`:''}<button class="btn p" ${!photo||photoLoading||busy?'disabled':''}>Save photo</button></form>`:''}
          ${form==='finish'&&!waitingForGcash?`<form aria-label="Confirm drop-off">${due?`<label><input type="checkbox" name="cash" required> I collected ${money(Number(o.total_amount))} in cash.</label>`:'<p>Confirm that the order reached the customer.</p>'}<button class="btn p" ${busy?'disabled':''}>Complete delivery</button></form>`:''}
        </div>
      </section>`:'<p>This delivery is no longer assigned to you.</p>';
      if(showGcash){
        gcashAmount.textContent=money(Number(o.total_amount));
        list.querySelector('[data-gcash-slot]').replaceWith(gcash);
        requestGcash.disabled=busy||gcashFrame.hidden;
      }else if(gcash.open||gcashUrl){
        gcash.open=false;
        clearGcashImage();
      }
      footer.innerHTML=o&&step!=='delivered'?`
        ${step==='store'&&o.status!=='out_for_delivery'?'<p>Wait for the store to select Hand to Rider.</p>':''}
        ${step==='arrived'&&!o.trip_proof?'<p>Add proof of delivery to continue.</p>':''}
        <button type="button" class="btn p blk" data-trip-action="next" ${!loaded||busy||waitingForGcash||
          (step==='store'&&o.status!=='out_for_delivery')||(step==='arrived'&&!o.trip_proof)?'disabled':''}>${labels[step]}</button>`:'';
      footer.hidden=!o||step==='delivered';
      const note=list.querySelector('textarea');
      if(note && previousDraft)note.value=previousDraft;
      if(focus)list.querySelector('[data-trip-action="'+focus+'"]')?.focus({preventScroll:true});
    }

    async function stopShare(message) {
      const session=share;
      if(!session)return;
      share=null;
      clearInterval(session.timer);
      if(alive()){if(message)tell(message);paint();}
      try {await rpc('papalita_tracking_share',{p_order_id:session.id,p_share_key:session.token});}
      catch {if(alive())tell('GPS stopped on this phone. The previous location expires within a minute.');}
    }
    function sample(session) {
      if (!alive() || share!==session || session.busy || document.hidden) return;
      session.busy=true;
      navigator.geolocation.getCurrentPosition(async position=>{
        try {
          if (!alive() || share!==session || document.hidden) return;
          const {latitude,longitude}=position.coords;
          map.gps(latitude,longitude);
          const saved=await rpc('papalita_tracking_position',{
            p_order_id:session.id,p_share_key:session.token,p_lat:latitude,p_lng:longitude
          });
          if (share!==session || !alive()) return;
          if (!saved) {void stopShare('This order is no longer available for GPS sharing.');return;}
          tell('Sharing GPS with this customer while Papalita is open.');
        } catch {
          if (share===session && alive()) tell('GPS could not sync. Retrying…');
        } finally {session.busy=false;}
      },error=>{
        session.busy=false;
        if (!alive() || share!==session) return;
        if(error.code===1)void stopShare('Location permission was denied. Allow GPS access and try again.');
        else tell('Waiting for a GPS fix.');
      },{enableHighAccuracy:true,maximumAge:0,timeout:10000});
    }
    async function startShare(o) {
      if (share || busy || o.status!=='out_for_delivery')return;
      if (!window.isSecureContext || !navigator.geolocation){tell('Open Papalita over HTTPS on a phone with GPS.');return;}
      busy=true;paint();tell('Allow location access when prompted.');
      try {
        const token=await rpc('papalita_tracking_share',{p_order_id:o.id});
        if (!token) throw Error('Could not start GPS sharing.');
        if (!alive()) {
          await rpc('papalita_tracking_share',{p_order_id:o.id,p_share_key:token});
          return;
        }
        const session={id:o.id,token,busy:false,timer:null};
        share=session;
        sample(session);
        session.timer=setInterval(()=>sample(session),7000);
      } catch(error) {if(alive())tell(error.message);}
      finally {busy=false;if(alive())paint();}
    }
    async function refresh() {
      if(!alive() || refreshing || document.hidden)return;
      refreshing=true;
      const started=mutation;
      try {
        const jobs=await rpc('papalita_rider_trip_orders');
        if(!alive()||started!==mutation)return;
        if (!Array.isArray(jobs)) throw Error('Could not load this trip.');
        if (!order?.trip_delivered_at) {
          order=jobs.find(job=>job.id===assignedOrder.id &&
            job.assignment_version===assignedOrder.assignment_version) ?? null;
        }
        if(share&&order?.status!=='out_for_delivery')void stopShare();
        if(!loaded || info.textContent.startsWith('Could not load trip'))tell('');
        loaded=true;
        paint();
      } catch(error) {
        if(alive()&&!share)tell('Could not load trip details. Reopen the trip to retry.');
      } finally {refreshing=false;}
    }
    async function send(action,extra={},message='Order updated.') {
      const o=order;
      if(!o||!loaded||busy)return;
      busy=true;mutation++;
      paint();
      try {
        let result;
        if(action==='report') {
          const saved=await rpc('papalita_rider_report_problem',{
            p_report_id:reportId ??= crypto.randomUUID(),p_order_id:o.id,
            p_assignment_version:o.assignment_version,...extra
          });
          if(saved!==true)throw Error('The report could not be confirmed.');
          reportId=undefined;
          result=o;
        } else {
          result=await rpc('papalita_rider_trip_action',{p_order_id:o.id,p_action:action,...extra});
        }
        if(!alive())return;
        if(result?.id!==o.id)throw Error('The server could not confirm this update.');
        order={...o,...result};
        if(action==='deliver'&&share?.id===o.id)await stopShare();
        clearForm();
        tell(message);
      } catch(error) {
        if(alive())tell(error.message||'Could not update this delivery.');
      } finally {busy=false;mutation++;if(alive()){paint();void refresh();}}
    }

    dialog.addEventListener('click',event=>{
      const action=event.target.closest('[data-trip-action]')?.dataset.tripAction;
      if(!action||busy||!loaded||!order)return;
      const o=order;
      if(action==='gps'){void (share?.id===o.id?stopShare('GPS sharing stopped.'):startShare(o));return;}
      if(action==='verify-gcash'){
        void send('request_gcash_verification',{},'GCash verification requested. Papalita has been notified.');
        return;
      }
      if(action==='next'){
        const step=phase(o);
        if(step==='arrived'){clearForm();form='finish';paint();list.querySelector('form')?.scrollIntoView({block:'nearest'});return;}
        const command={offer:'accept',pickup:'at_store',store:'pickup',transit:'arrive'}[step];
        if(command)void send(command);
        return;
      }
      const previous=form;
      clearForm();
      if(previous!==action)form=action;
      paint();
      if(form)list.querySelector('form')?.scrollIntoView({block:'nearest'});
    });
    list.addEventListener('change',async event=>{
      const file=event.target.name==='photo'&&event.target.files?.[0];
      if(!file)return;
      photo='';photoLoading=true;
      const current=++revision;
      paint();
      try {const data=await photoData(file);if(current===revision&&alive())photo=data;}
      catch(error){if(current===revision&&alive())tell(error.message||'Could not read that photo.');}
      finally {if(current===revision&&alive()){photoLoading=false;paint();}}
    });
    list.addEventListener('submit',event=>{
      event.preventDefault();
      const values=new FormData(event.target);
      if(form==='report')void send('report',{p_reason:values.get('reason'),p_note:values.get('note')},'Issue sent to Papalita.');
      if((form==='pickup-photo'||form==='proof')&&photo)void send(form==='proof'?'proof':'pickup_photo',{p_photo:photo},'Photo saved.');
      if(form==='finish')void send('deliver',{p_cash_confirmed:values.has('cash')},'Delivery completed.');
    });
    const leaving=()=>{if(gpsWatch!=null)navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;void stopShare();};
    const visibility=()=>{
      if(!alive())return;
      if(document.hidden){map.gps();if(share)tell('GPS paused while Papalita is in the background.');return;}
      if(share)sample(share);
      void refresh();
    };
    if (window.isSecureContext && navigator.geolocation) {
      // This location stays on the phone until the rider explicitly starts sharing.
      const locate=document.createElement('button');
      locate.type='button';locate.className='btn s sm pr-trip-locate';locate.textContent='My location';
      locate.hidden=true;
      map.ready.then(renderer=>{if(alive())locate.hidden=!renderer;});
      locate.onclick=()=>{
        if(gpsWatch!=null)return;
        gpsWatch=navigator.geolocation.watchPosition(({coords})=>{
          if(alive()&&!document.hidden)map.gps(coords.latitude,coords.longitude);
        },()=>{if(gpsWatch!=null)navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;tell('Your position is unavailable. Check GPS permissions.');},{enableHighAccuracy:true,timeout:10000});
      };
      dialog.querySelector('[data-trip-map]').before(locate);
    }
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('pagehide',leaving);
    const poll=setInterval(refresh,5000);
    dialog.addEventListener('close',()=>{
      clearInterval(poll);
      clearGcashImage();
      if(gpsWatch!=null)navigator.geolocation.clearWatch(gpsWatch);
      map.close();
      document.removeEventListener('visibilitychange',visibility);
      window.removeEventListener('pagehide',leaving);
      void stopShare();
    },{once:true});
    paint();
    void refresh();
  }
  window.PapalitaRiderTrip={open};
})();
