const gate=document.getElementById('ageGate');
const ok=document.getElementById('ageOk');
if(localStorage.getItem('bp_age_ok')==='yes') gate.classList.add('hide');
ok?.addEventListener('click',()=>{localStorage.setItem('bp_age_ok','yes');gate.classList.add('hide')});
const cards=document.querySelectorAll('.product,.sale-card,.review,.benefits div');
const io=new IntersectionObserver((entries)=>entries.forEach(e=>{if(e.isIntersecting)e.target.animate([{opacity:0,transform:'translateY(22px)'},{opacity:1,transform:'translateY(0)'}],{duration:550,fill:'forwards',easing:'ease-out'})}),{threshold:.15});
cards.forEach(c=>io.observe(c));
