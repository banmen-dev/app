// 見本用。アプリと同じ正方形、ドラッグ・矢印キー・移動ボタン・拡大率。
(() => {
  function mount(root) {
    if (root.dataset.cropMounted) return;
    root.dataset.cropMounted = 'true';
    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const button = root.querySelector('.image-crop-preview');
    const range = root.querySelector('input[type="range"]');
    let x = 200, y = 150, zoom = 1, drag = null;
    const source = document.createElement('canvas'); source.width = 400; source.height = 300;
    const paint = source.getContext('2d');
    const colors = ['#0b57d0', '#e8effc', '#58636f'];
    for (let row = 0; row < 6; row++) for (let col = 0; col < 8; col++) {
      paint.fillStyle = colors[(row + col) % colors.length]; paint.fillRect(col * 50, row * 50, 50, 50);
    }
    function draw(dx = 0, dy = 0) {
      const size = 300 / zoom;
      x = Math.max(size / 2, Math.min(400 - size / 2, x + dx));
      y = Math.max(size / 2, Math.min(300 - size / 2, y + dy));
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(source, x - size / 2, y - size / 2, size, size, 0, 0, 256, 256);
    }
    range.oninput = () => { zoom = Number(range.value); draw(); };
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    button.onkeydown = (event) => { const d = directions[event.key]; if (!d) return; event.preventDefault(); draw(d[0] * 6 / zoom, d[1] * 6 / zoom); };
    root.querySelectorAll('[data-crop-move]').forEach((el) => el.onclick = () => { const d = directions[el.dataset.cropMove]; draw(d[0] * 30 / zoom, d[1] * 30 / zoom); });
    button.onpointerdown = (event) => { if (!event.isPrimary || event.button !== 0) return; button.setPointerCapture(event.pointerId); drag = [event.clientX, event.clientY]; };
    button.onpointermove = (event) => { if (!drag) return; const scale = 300 / zoom / button.getBoundingClientRect().width; draw((event.clientX - drag[0]) * scale, (event.clientY - drag[1]) * scale); drag = [event.clientX, event.clientY]; };
    button.onpointerup = button.onpointercancel = button.onlostpointercapture = () => { drag = null; };
    draw();
  }
  const mountAll = () => document.querySelectorAll('[data-image-crop]').forEach(mount);
  mountAll();
  SQ.onRedraw(mountAll);
})();
