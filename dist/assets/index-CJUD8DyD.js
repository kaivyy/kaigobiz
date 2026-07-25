(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const a of document.querySelectorAll('link[rel="modulepreload"]'))n(a);new MutationObserver(a=>{for(const r of a)if(r.type==="childList")for(const o of r.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&n(o)}).observe(document,{childList:!0,subtree:!0});function t(a){const r={};return a.integrity&&(r.integrity=a.integrity),a.referrerPolicy&&(r.referrerPolicy=a.referrerPolicy),a.crossOrigin==="use-credentials"?r.credentials="include":a.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function n(a){if(a.ep)return;a.ep=!0;const r=t(a);fetch(a.href,r)}})();class m{static async checkout(e){try{const n=await(await fetch(`${e.endpoint}/api/v1/payment/create`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:e.orderId,amount:e.amount})})).json();if(!n.success){e.onError&&e.onError(n);return}m.showModal(n,e)}catch(t){e.onError&&e.onError(t)}}static showModal(e,t){const n=document.createElement("div");n.className="kaigobiz-modal-overlay",n.innerHTML=`
      <div class="kaigobiz-modal-card">
        <h3 style="margin:0;font-size:18px;">Pembayaran QRIS</h3>
        <p style="margin:4px 0;font-size:12px;color:#94a3b8;">Order: ${e.orderId}</p>
        <div class="kaigobiz-amount">Rp ${Number(e.amount).toLocaleString("id-ID")}</div>
        <div class="kaigobiz-qr-box">
          <img src="${e.qrisQrUrl}" alt="QRIS QR Code" style="width:200px;height:200px;display:block;" />
        </div>
        <div class="kaigobiz-timer" id="kaigobiz-timer">Batas Waktu: 05:00</div>
        <button id="kaigobiz-close-btn" style="margin-top:16px;background:#334155;color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;">Batal</button>
      </div>
    `,document.body.appendChild(n);const a=n.querySelector("#kaigobiz-close-btn");a==null||a.addEventListener("click",()=>{clearInterval(l),clearInterval(d),document.body.removeChild(n)});const r=new Date(e.expiresAt).getTime(),o=n.querySelector("#kaigobiz-timer"),d=setInterval(()=>{const c=Math.max(0,Math.floor((r-Date.now())/1e3)),u=String(Math.floor(c/60)).padStart(2,"0"),w=String(c%60).padStart(2,"0");o&&(o.textContent=`Batas Waktu: ${u}:${w}`),c<=0&&(clearInterval(d),clearInterval(l),t.onExpired&&t.onExpired(),document.body.removeChild(n))},1e3),l=setInterval(async()=>{try{const u=await(await fetch(`${t.endpoint}/api/v1/payment/status/${e.paymentId}`)).json();u.status==="PAID"&&(clearInterval(l),clearInterval(d),t.onSuccess&&t.onSuccess(u),document.body.removeChild(n))}catch{}},3e3)}}typeof window<"u"&&(window.KaiGoBiz=m);let I="",k="";async function E(){const s=document.getElementById("status-badge"),e=document.getElementById("session-info");try{const n=await(await fetch("/api/v1/auth/status")).json();if(n.connected&&n.session){if(s&&(s.className="badge online",s.innerHTML='<span class="dot"></span><span class="text">Online</span>'),e){const a=n.session.outlet_name||"Merchant GoBiz",r=n.session.phone_number||"-",o=n.session.merchant_id||"-",d=n.session.expires_at?new Date(n.session.expires_at).toLocaleString("id-ID"):"-";e.innerHTML=`
          <div><strong>Outlet:</strong> ${a}</div>
          <div><strong>No. Handphone:</strong> ${r}</div>
          <div><strong>Merchant ID:</strong> ${o}</div>
          <div><strong>Berlaku Hingga:</strong> ${d}</div>
        `}}else s&&(s.className="badge offline",s.innerHTML='<span class="dot"></span><span class="text">Offline</span>'),e&&(e.innerHTML="Sesi GoBiz belum terhubung. Silakan minta & verifikasi kode OTP di bawah.")}catch{s&&(s.className="badge offline",s.innerHTML='<span class="dot"></span><span class="text">Server Offline</span>'),e&&(e.innerHTML="Gagal terhubung ke API KaiGoBiz Server.")}}function i(s,e){const t=document.getElementById("otp-message");t&&(t.className=`message-banner ${e}`,t.textContent=s,t.style.display="block")}function f(){const s=document.getElementById("otp-message");s&&(s.style.display="none")}var y;(y=document.getElementById("otp-request-form"))==null||y.addEventListener("submit",async s=>{s.preventDefault(),f();const e=document.getElementById("phone-input"),t=document.getElementById("btn-request-otp"),n=document.getElementById("otp-verify-form");if(!e||!t)return;const a=e.value.trim();if(!a){i("Nomor handphone harus diisi","error");return}t.disabled=!0,t.innerHTML='<span class="loading-spinner"></span> Memproses...';try{const r=await fetch("/api/v1/auth/request-otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:a})}),o=await r.json();r.ok&&o.success&&o.otpToken?(I=o.otpToken,k=a,i(`Kode OTP telah dikirim ke ${a}. Silakan masukkan kode OTP di bawah.`,"success"),n&&(n.style.display="flex")):i(o.error||"Gagal mengirim OTP","error")}catch(r){i(r.message||"Terjadi kesalahan jaringan","error")}finally{t.disabled=!1,t.innerHTML='<span>Kirim Kode OTP</span><span class="arrow">→</span>'}});var g;(g=document.getElementById("otp-verify-form"))==null||g.addEventListener("submit",async s=>{s.preventDefault(),f();const e=document.getElementById("otp-input"),t=document.getElementById("btn-verify-otp"),n=document.getElementById("otp-verify-form");if(!e||!t)return;const a=e.value.trim();if(!a){i("Kode OTP harus diisi","error");return}t.disabled=!0,t.innerHTML='<span class="loading-spinner"></span> Memverifikasi...';try{const r=await fetch("/api/v1/auth/verify-otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:k,otp:a,otpToken:I})}),o=await r.json();r.ok&&o.success?(i("Berhasil terhubung dengan sesi GoBiz!","success"),n&&(n.style.display="none"),e.value="",await E(),await p()):i(o.error||"Verifikasi OTP gagal","error")}catch(r){i(r.message||"Terjadi kesalahan jaringan","error")}finally{t.disabled=!1,t.textContent="Verifikasi OTP"}});var h;(h=document.getElementById("btn-cancel-otp"))==null||h.addEventListener("click",()=>{const s=document.getElementById("otp-verify-form");s&&(s.style.display="none"),f()});document.querySelectorAll(".btn-preset").forEach(s=>{s.addEventListener("click",e=>{const t=e.currentTarget.getAttribute("data-amount"),n=document.getElementById("amount-input");n&&t&&(n.value=t)})});var v;(v=document.getElementById("create-payment-form"))==null||v.addEventListener("submit",s=>{s.preventDefault();const e=document.getElementById("order-id-input"),t=document.getElementById("amount-input");if(!e||!t)return;const n=e.value.trim()||`INV-${Date.now()}`,a=Number(t.value);if(!a||a<=0){alert("Nominal harus lebih besar dari 0");return}m.checkout({endpoint:window.location.origin,orderId:n,amount:a,onSuccess:r=>{alert(`Pembayaran Sukses! (Order ID: ${r.orderId||n})`),p()},onExpired:()=>{alert("Batas waktu pembayaran telah habis (Expired).")},onError:r=>{alert("Gagal memproses pembayaran: "+(r.error||JSON.stringify(r)))}})});async function p(){const s=document.getElementById("tx-table-container"),e=document.getElementById("refresh-tx-btn");e&&e.classList.add("loading"),s&&(s.innerHTML=`
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Mengambil mutasi transaksi terbaru...</span>
      </div>
    `);try{const a=(await(await fetch("/api/v1/transactions")).json()).transactions||[];if(!s)return;if(a.length===0){s.innerHTML=`
        <div class="empty-state">
          <div style="font-size:32px;">📭</div>
          <p>Belum ada riwayat mutasi transaksi.</p>
        </div>
      `;return}const r=a.map(o=>{const d=(o.status||"PENDING").toLowerCase(),l=`Rp ${Number(o.amount).toLocaleString("id-ID")}`,c=o.timestamp?new Date(o.timestamp).toLocaleString("id-ID"):"-";return`
        <tr>
          <td><code style="color:#38bdf8;">${o.id}</code></td>
          <td style="font-weight:700;">${l}</td>
          <td>${o.description||"GoPay Dynamic QRIS"}</td>
          <td style="color:#94a3b8;">${c}</td>
          <td><span class="tx-status-badge ${d}">${o.status}</span></td>
        </tr>
      `}).join("");s.innerHTML=`
      <table class="tx-table">
        <thead>
          <tr>
            <th>ID Transaksi</th>
            <th>Nominal</th>
            <th>Deskripsi</th>
            <th>Waktu</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${r}
        </tbody>
      </table>
    `}catch{s&&(s.innerHTML=`
        <div class="empty-state">
          <div style="font-size:32px;color:#f87171;">⚠️</div>
          <p>Gagal memuat transaksi. Pastikan server API berjalan.</p>
        </div>
      `)}finally{e&&e.classList.remove("loading")}}var b;(b=document.getElementById("refresh-tx-btn"))==null||b.addEventListener("click",()=>{p()});document.addEventListener("DOMContentLoaded",()=>{E(),p()});
