const previews = {
  home: {
    source: new URL('../docs/images/axonkey-home.png', import.meta.url).href,
    alt: 'Axonkey 主页，展示设备状态、系统权限、语音通道和快捷操作',
    caption: '设备、权限与语音状态，打开就能看清。',
  },
  mapping: {
    source: new URL('../docs/images/axonkey-mapping.png', import.meta.url).href,
    alt: 'Axonkey 按键映射界面，可选择实体按键并编辑触发行为',
    caption: '单击、双击与长按，各有自己的用途。',
  },
  overview: {
    source: new URL('../docs/images/axonkey-overview.png', import.meta.url).href,
    alt: 'Axonkey 总览，展示遥控器各按键的映射行为与触发方式',
    caption: '每个按键对应什么动作，一眼看清。',
  },
};

const screenshot = document.querySelector('#app-screenshot');
const caption = document.querySelector('#preview-caption');
const previewButtons = document.querySelectorAll('[data-preview]');

previewButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const preview = previews[button.dataset.preview];
    screenshot.src = preview.source;
    screenshot.alt = preview.alt;
    caption.textContent = preview.caption;
    previewButtons.forEach((item) => {
      item.setAttribute('aria-pressed', String(item === button));
    });
  });
});
