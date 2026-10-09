(() => {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const initData = (tg && tg.initData) || '';
  const app = document.getElementById('app');
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hap = t => { try { tg.HapticFeedback.impactOccurred(t || 'light'); } catch (e) {} };

  const S = { cfg: null, ads: [], hasMore: false, loading: false, loaded: false,
              f: { q: '', category: '', sort: 'new' }, hist: [], cur: { name: 'feed' } };

  // ---------- helpers ----------
  async function api(url, opts = {}) {
    const headers = Object.assign({ 'X-Telegram-Init-Data': initData }, opts.headers || {});
    const r = await fetch(url, Object.assign({}, opts, { headers }));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }
  const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const ask = msg => new Promise(res => {
    if (tg && tg.showConfirm) tg.showConfirm(msg, ok => res(!!ok)); else res(confirm(msg));
  });
  const price = p => p == null ? 'Договорная' : new Intl.NumberFormat('ru-RU').format(p) + ' ' + S.cfg.currency;
  const ago = ts => {
    const d = Date.now() / 1000 - ts;
    if (d < 60) return 'только что';
    if (d < 3600) return Math.floor(d / 60) + ' мин назад';
    if (d < 86400) return Math.floor(d / 3600) + ' ч назад';
    if (d < 7 * 86400) return Math.floor(d / 86400) + ' дн назад';
    return new Date(ts * 1000).toLocaleDateString('ru-RU');
  };
  const openTg = url => (tg && tg.openTelegramLink) ? tg.openTelegramLink(url) : window.open(url, '_blank');

  // ---------- навигация ----------
  function openView(name, arg) { S.cur.scrollY = window.scrollY; S.hist.push(S.cur); S.cur = { name, arg }; render(); }
  function goTab(name) { S.hist = []; S.cur = { name }; render(); }
  function back() { S.cur = S.hist.pop() || { name: 'feed' }; render(); }

  function render() {
    const root = (S.hist[0] || S.cur).name;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === root));
    if (tg && tg.BackButton) { S.hist.length ? tg.BackButton.show() : tg.BackButton.hide(); }
    const v = { feed, detail, create, mine, favs }[S.cur.name];
    v(S.cur.arg);
    window.scrollTo(0, S.cur.scrollY || 0);
  }
  if (tg && tg.BackButton) tg.BackButton.onClick(back);
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { hap(); goTab(b.dataset.tab); });

  // ---------- карточки ----------
  const card = a => `
    <div class="card" data-id="${a.id}">
      <div class="ph">${a.photos[0] ? `<img loading="lazy" src="${a.photos[0]}" alt="">` : '📷'}
        <button class="heart ${a.fav ? 'on' : ''}" data-fav="${a.id}">♥</button>
        ${a.status === 'sold' ? '<i class="badge">Продано</i>' : ''}
      </div>
      <div class="p">${esc(price(a.price))}</div>
      <div class="t">${esc(a.title)}</div>
      <div class="m">${esc(a.city || '')}${a.city ? ' · ' : ''}${ago(a.updated_at)}</div>
    </div>`;

  async function toggleFav(id, list, inFavs) {
    try {
      const r = await api('/api/favorites/' + id, { method: 'POST' });
      hap('medium');
      const a = list.find(x => x.id === id); if (a) a.fav = r.fav;
      const other = S.ads.find(x => x.id === id); if (other) other.fav = r.fav;
      if (inFavs && !r.fav) { const i = list.findIndex(x => x.id === id); if (i > -1) list.splice(i, 1); }
    } catch (e) { toast(e.message); }
  }
  function bindGrid(el, list, redraw, inFavs) {
    el.onclick = async e => {
      const fav = e.target.closest('[data-fav]');
      if (fav) { e.stopPropagation(); await toggleFav(+fav.dataset.fav, list, inFavs); redraw(); return; }
      const c = e.target.closest('.card'); if (c) openView('detail', +c.dataset.id);
    };
  }

  // ---------- Лента ----------
  function feed() {
    const cats = ['', ...S.cfg.categories];
    app.innerHTML = `
      <div class="top">
        <div class="row">
          <input id="q" type="search" placeholder="Поиск объявлений" value="${esc(S.f.q)}">
          <select id="sort">
            <option value="new">Новые</option><option value="cheap">Дешевле</option><option value="exp">Дороже</option>
          </select>
        </div>
        <div class="chips">${cats.map(c => `<button class="chip ${S.f.category === c ? 'on' : ''}" data-c="${esc(c)}">${c || 'Все'}</button>`).join('')}</div>
      </div>
      <div id="grid" class="grid"></div>
      <div id="more" class="more"></div>`;
    $('#sort').value = S.f.sort;
    let t;
    $('#q').oninput = e => { clearTimeout(t); t = setTimeout(() => { S.f.q = e.target.value.trim(); loadAds(true); }, 350); };
    $('#sort').onchange = e => { S.f.sort = e.target.value; loadAds(true); };
    document.querySelectorAll('.chip').forEach(ch => ch.onclick = () => {
      S.f.category = ch.dataset.c;
      document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === ch));
      loadAds(true);
    });
    bindGrid($('#grid'), S.ads, drawFeed);
    drawFeed();
    if (!S.loaded) loadAds(true);
  }
  function drawFeed() {
    const g = $('#grid'); if (!g) return;
    if (S.loading && !S.ads.length) g.innerHTML = '<div class="skel"></div>'.repeat(4);
    else if (!S.ads.length) g.innerHTML = '<div class="empty">😕<br>Ничего не найдено.<br>Станьте первым — нажмите «Продать»</div>';
    else g.innerHTML = S.ads.map(card).join('');
    const m = $('#more');
    if (m) {
      m.innerHTML = S.hasMore ? '<button class="btn sec" id="moreBtn">Показать ещё</button>' : '';
      if (S.hasMore) $('#moreBtn').onclick = () => loadAds(false);
    }
  }
  async function loadAds(reset) {
    if (S.loading) return;
    if (reset) { S.ads.length = 0; S.hasMore = false; }
    S.loading = true; drawFeed();
    try {
      const p = new URLSearchParams({ q: S.f.q, category: S.f.category, sort: S.f.sort, offset: S.ads.length });
      const r = await api('/api/ads?' + p);
      S.ads.push(...r.items); S.hasMore = r.hasMore; S.loaded = true;
    } catch (e) { toast(e.message); }
    S.loading = false;
    if (S.cur.name === 'feed') drawFeed();
  }

  // ---------- Карточка объявления ----------
  async function detail(id) {
    app.innerHTML = '<div class="pad muted">Загрузка…</div>';
    let a;
    try { a = await api('/api/ads/' + id); } catch (e) { app.innerHTML = `<div class="pad"><h2>Ой</h2><p class="muted">${esc(e.message)}</p></div>`; return; }
    if (S.cur.name !== 'detail' || S.cur.arg !== id) return;
    const canManage = a.mine, canDelete = a.mine || S.cfg.me.is_admin;
    const contact = a.seller_username ? '@' + esc(a.seller_username) : '';
    app.innerHTML = `
      <div class="detail">
        <div class="gal">${a.photos.map(p => `<img src="${p}" alt="">`).join('') || '<div class="noph">📷</div>'}</div>
        <div class="pad">
          <div class="price">${esc(price(a.price))}</div>
          <h1>${esc(a.title)}</h1>
          ${a.status === 'sold' ? '<div class="sold">Продано</div>' : ''}
          <div class="muted small">${esc(a.category)}${a.city ? ' · ' + esc(a.city) : ''} · ${ago(a.updated_at)} · 👁 ${a.views}</div>
          <p class="desc">${esc(a.description || 'Без описания').replace(/\n/g, '<br>')}</p>
          <div class="seller">👤 ${esc(a.seller_name || 'Продавец')} ${contact}</div>
          <div class="actions" id="acts"></div>
        </div>
      </div>`;
    const acts = $('#acts');
    const add = (html, fn) => { const d = document.createElement('div'); d.innerHTML = html; const b = d.firstElementChild; b.onclick = fn; acts.appendChild(b); };

    if (!canManage) {
      if (a.seller_username && a.status === 'active')
        add('<button class="btn">💬 Написать продавцу</button>', () => openTg('https://t.me/' + a.seller_username));
      add(`<button class="btn sec">${a.fav ? '💔 Убрать из избранного' : '❤️ В избранное'}</button>`, async () => { await toggleFav(a.id, [a], false); detail(a.id); });
      add('<button class="btn sec">📤 Поделиться</button>', () => share(a));
      add('<button class="btn danger">🚩 Пожаловаться</button>', async () => {
        if (await ask('Отправить жалобу на это объявление?')) {
          try { await api(`/api/ads/${a.id}/report`, { method: 'POST' }); toast('Спасибо, жалоба отправлена'); } catch (e) { toast(e.message); }
        }
      });
    } else {
      add('<button class="btn sec">📤 Поделиться</button>', () => share(a));
    }
    if (canManage) {
      add(`<button class="btn sec">${a.status === 'sold' ? '↩️ Вернуть в продажу' : '✅ Отметить проданным'}</button>`, async () => {
        try { await api('/api/ads/' + a.id, jsonOpts('PUT', { status: a.status === 'sold' ? 'active' : 'sold' })); S.loaded = false; toast('Готово'); detail(a.id); } catch (e) { toast(e.message); }
      });
      if (a.status === 'active') add('<button class="btn sec">🔝 Поднять в ленте</button>', async () => {
        try { await api('/api/ads/' + a.id, jsonOpts('PUT', { action: 'bump' })); S.loaded = false; toast('Поднято наверх'); } catch (e) { toast(e.message); }
      });
    }
    if (canDelete) add('<button class="btn danger">🗑 Удалить</button>', async () => {
      if (!(await ask('Удалить объявление навсегда?'))) return;
      try { await api('/api/ads/' + a.id, { method: 'DELETE' }); S.loaded = false; toast('Удалено'); back(); } catch (e) { toast(e.message); }
    });
  }
  function share(a) {
    const c = S.cfg;
    if (!c.bot_username) return toast('Укажите BOT_USERNAME в .env, чтобы делиться');
    const link = c.app_short_name
      ? `https://t.me/${c.bot_username}/${c.app_short_name}?startapp=ad_${a.id}`
      : `https://t.me/${c.bot_username}?startapp=ad_${a.id}`;
    openTg('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(a.title + ' — ' + price(a.price)));
  }

  // ---------- Подача объявления ----------
  function compress(file) {
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => b ? res(b) : rej(new Error('Не удалось обработать фото')), 'image/jpeg', 0.82);
      };
      img.onerror = () => rej(new Error('Не удалось открыть фото'));
      img.src = url;
    });
  }

  function create() {
    if (!S.cfg.me.username) {
      app.innerHTML = `<div class="pad"><h2>Нужен username</h2><p class="muted">Покупатели будут писать вам в Telegram. Задайте username в Настройках Telegram → «Имя пользователя», затем откройте маркет заново.</p></div>`;
      return;
    }
    const photos = []; // {blob, url}
    app.innerHTML = `
      <div class="form">
        <h2>Новое объявление</h2>
        <label>Фото (до 5)<div class="thumbs" id="thumbs"></div></label>
        <input id="file" type="file" accept="image/*" multiple hidden>
        <label>Название<input id="title" maxlength="80" placeholder="Например: iPhone 13, 128 ГБ"></label>
        <label>Категория<select id="cat">${S.cfg.categories.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label>Цена, ${esc(S.cfg.currency)} (пусто = договорная)<input id="price" type="number" inputmode="numeric" min="0" placeholder="0"></label>
        <label>Город<input id="city" maxlength="40" placeholder="Минск"></label>
        <label>Описание<textarea id="desc" maxlength="2000" placeholder="Состояние, комплектация, как удобно забрать…"></textarea></label>
        <button class="btn" id="send">Опубликовать</button>
      </div>`;
    const drawThumbs = () => {
      $('#thumbs').innerHTML = photos.map((p, i) => `<div class="thumb"><img src="${p.url}"><button data-i="${i}">✕</button></div>`).join('') +
        (photos.length < 5 ? '<div class="addph" id="add">＋</div>' : '');
      document.querySelectorAll('.thumb button').forEach(b => b.onclick = () => { photos.splice(+b.dataset.i, 1); drawThumbs(); });
      const add = $('#add'); if (add) add.onclick = () => $('#file').click();
    };
    drawThumbs();
    $('#file').onchange = async e => {
      for (const f of [...e.target.files].slice(0, 5 - photos.length)) {
        try { const blob = await compress(f); photos.push({ blob, url: URL.createObjectURL(blob) }); } catch (err) { toast(err.message); }
      }
      e.target.value = ''; drawThumbs();
    };
    $('#send').onclick = async () => {
      const title = $('#title').value.trim();
      if (title.length < 3) return toast('Введите название (от 3 символов)');
      const fd = new FormData();
      fd.append('title', title); fd.append('category', $('#cat').value); fd.append('price', $('#price').value);
      fd.append('city', $('#city').value.trim()); fd.append('description', $('#desc').value.trim());
      photos.forEach((p, i) => fd.append('photos', p.blob, `photo${i}.jpg`));
      const btn = $('#send'); btn.disabled = true; btn.textContent = 'Публикуем…';
      try {
        await api('/api/ads', { method: 'POST', body: fd });
        hap('medium'); S.loaded = false; toast('Объявление опубликовано 🎉'); goTab('mine');
      } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Опубликовать'; }
    };
  }

  // ---------- Мои объявления ----------
  async function mine() {
    app.innerHTML = '<div class="pad muted">Загрузка…</div>';
    let items;
    try { items = (await api('/api/my/ads')).items; } catch (e) { app.innerHTML = `<div class="pad">${esc(e.message)}</div>`; return; }
    if (S.cur.name !== 'mine') return;
    if (!items.length) { app.innerHTML = '<div class="empty">📦<br>У вас пока нет объявлений.<br>Нажмите «Продать», чтобы создать первое.</div>'; return; }
    app.innerHTML = `<div class="list">${items.map(a => `
      <div class="item" data-id="${a.id}">
        <div class="im">${a.photos[0] ? `<img src="${a.photos[0]}">` : '📷'}</div>
        <div><b>${esc(price(a.price))}</b><br>${esc(a.title)}<br>
          <span class="muted small">${a.status === 'sold' ? '✅ Продано' : '🟢 Активно'} · 👁 ${a.views} · ${ago(a.updated_at)}</span></div>
        <div class="btns">
          <button data-a="toggle">${a.status === 'sold' ? 'Вернуть' : 'Продано'}</button>
          ${a.status === 'active' ? '<button data-a="bump">Поднять</button>' : ''}
          <button class="del" data-a="del">Удалить</button>
        </div>
      </div>`).join('')}</div>`;
    $('.list').onclick = async e => {
      const it = e.target.closest('.item'); if (!it) return;
      const id = +it.dataset.id, a = items.find(x => x.id === id), act = e.target.dataset.a;
      if (!act) return openView('detail', id);
      try {
        if (act === 'toggle') await api('/api/ads/' + id, jsonOpts('PUT', { status: a.status === 'sold' ? 'active' : 'sold' }));
        if (act === 'bump') { await api('/api/ads/' + id, jsonOpts('PUT', { action: 'bump' })); toast('Поднято наверх'); }
        if (act === 'del') { if (!(await ask('Удалить объявление навсегда?'))) return; await api('/api/ads/' + id, { method: 'DELETE' }); }
        S.loaded = false; mine();
      } catch (err) { toast(err.message); }
    };
  }

  // ---------- Избранное ----------
  async function favs() {
    app.innerHTML = '<div class="pad muted">Загрузка…</div>';
    let items;
    try { items = (await api('/api/favorites')).items; } catch (e) { app.innerHTML = `<div class="pad">${esc(e.message)}</div>`; return; }
    if (S.cur.name !== 'favs') return;
    const draw = () => {
      app.innerHTML = items.length ? '<div class="grid" id="fg"></div>' : '<div class="empty">❤️<br>Здесь будут объявления,<br>которые вы отметили сердечком</div>';
      if (items.length) { $('#fg').innerHTML = items.map(card).join(''); bindGrid($('#fg'), items, draw, true); }
    };
    draw();
  }

  // ---------- Старт ----------
  (async () => {
    try { S.cfg = await api('/api/config'); }
    catch (e) {
      app.innerHTML = `<div class="pad"><h2>Откройте из Telegram</h2><p class="muted">${esc(e.message)}</p></div>`;
      return;
    }
    render();
    const sp = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param;
    if (sp && /^ad_\d+$/.test(sp)) openView('detail', +sp.slice(3));
  })();
})();
