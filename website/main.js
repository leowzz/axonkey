const previews = {
  home: {
    source: new URL('../docs/images/axonkey-home.png', import.meta.url).href,
    alt: 'Axonkey 主页，展示设备状态、系统权限、语音通道和快捷操作',
  },
  mapping: {
    source: new URL('../docs/images/axonkey-mapping.png', import.meta.url).href,
    alt: 'Axonkey 按键映射界面，可选择实体按键并编辑触发行为',
  },
  overview: {
    source: new URL('../docs/images/axonkey-overview.png', import.meta.url).href,
    alt: 'Axonkey 总览，展示遥控器各按键的映射行为与触发方式',
  },
};

const screenshot = document.querySelector('#app-screenshot');
const previewButtons = document.querySelectorAll('[data-preview]');

function selectPreview(button) {
  const preview = previews[button.dataset.preview];
  screenshot.src = preview.source;
  screenshot.alt = preview.alt;
  previewButtons.forEach((item) => {
    item.setAttribute('aria-pressed', String(item === button));
  });
}

previewButtons.forEach((button) => {
  button.addEventListener('click', () => selectPreview(button));
});
selectPreview(document.querySelector('[data-preview][aria-pressed="true"]'));

const viewer = document.querySelector('#image-viewer');
const viewerImage = document.querySelector('#viewer-image');
const openScreenshot = document.querySelector('#open-screenshot');

openScreenshot.addEventListener('click', () => {
  viewerImage.src = screenshot.src;
  viewerImage.alt = screenshot.alt;
  viewer.showModal();
});

viewer.querySelector('.viewer-close').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', (event) => {
  if (event.target === viewer) viewer.close();
});
viewer.addEventListener('close', () => openScreenshot.focus({ preventScroll: true }));
