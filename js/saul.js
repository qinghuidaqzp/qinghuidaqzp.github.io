// 1. 创建开屏容器
var introDiv = document.createElement('div');
introDiv.id = 'saul-intro';
introDiv.innerHTML = `
    <div class="saul-content">
        <h1 class="saul-title">BETTER<br>CALL<br>ME</h1>
        <p class="saul-subtitle">LAWYER UP • STREET • FREEDOM</p>
        <div class="scroll-indicator">↓ SCROLL TO START ↓</div>
    </div>
    <div class="saul-noise"></div>
`;
document.body.appendChild(introDiv);

// 2. 简单的滚动消失逻辑
window.addEventListener('scroll', function() {
    var scrollPosition = window.scrollY;
    var intro = document.getElementById('saul-intro');
    
    // 只有当 intro 元素存在时才执行
    if (intro) {
        // 滚动超过 100px 开始变透明，超过 500px 完全消失
        if (scrollPosition > 100) {
            intro.style.opacity = '0';
            // 延迟一点点时间把点击穿透属性加上，防止误触
            setTimeout(function(){
                intro.style.pointerEvents = 'none'; 
            }, 500);
        } else {
            intro.style.opacity = '1';
            intro.style.pointerEvents = 'auto';
        }
    }
});