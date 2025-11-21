// 这里的代码不需要考虑 YAML 的缩进问题，直接粘
var ap = new APlayer({
    container: document.getElementById('aplayer'),
    fixed: true,          // 开启吸底模式
    autoplay: true,       // 注意：手机和部分浏览器会拦截自动播放
    theme: '#fcee0a',
    loop: 'all',
    order: 'list',
    preload: 'auto',
    volume: 0.7,
    listFolded: true,
    audio: [
      {
        name: '22',
        artist: 'Taylor Swift',
        url: '/music/22.mp3',
        cover: 'https://i.imgur.com/123456.jpg'
      },
      {
        name: 'Cruel Summer',
        artist: 'Taylor Swift',
        url: '/music/Cruel_Summer.aac', 
        cover: ''
      }
    ]
});