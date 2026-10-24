// 离屏截图管线的共享实现。舞台验收图（stage.capture）和道具图标
// （item-icons.capture）都是「渲染到 MSAA 离屏 target → 读回像素 →
// 逐行翻转 → canvas → PNG」，只有相机/背景/letterbox 的准备不同。
// 这里只保留真正公共的那一段，渲染前的状态保存与恢复由调用方负责。

// 保存渲染器的可恢复状态。渲染器是全局单例，离屏渲染结束后必须原样还原，
// 否则主画面会停留在离屏 target 或错误的 viewport 上。
export function saveRendererState(renderer, THREE) {
    return {
        target: renderer.getRenderTarget(),
        color: renderer.getClearColor(new THREE.Color()),
        alpha: renderer.getClearAlpha(),
        viewport: renderer.getViewport(new THREE.Vector4()),
        scissor: renderer.getScissor(new THREE.Vector4()),
        test: renderer.getScissorTest()
    };
}

export function restoreRendererState(renderer, state) {
    renderer.setRenderTarget(state.target);
    renderer.setViewport(state.viewport);
    renderer.setScissor(state.scissor);
    renderer.setScissorTest(state.test);
    renderer.setClearColor(state.color, state.alpha);
}

// 4x MSAA + sRGB 的离屏 target 是这个项目所有截图的口径：单采样会让
// 纸片模型边缘出现硬锯齿，验收图与图标都必须一致。
export function createCaptureTarget(THREE, width, height) {
    const target = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    return target;
}

// WebGL 的像素原点在左下，canvas ImageData 在左上：按行翻转后
// putImageData 才能得到正立的图。
export function readTargetPng(renderer, target, width, height) {
    const bytes = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, bytes);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const image = context.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
        image.data.set(bytes.subarray((height - y - 1) * rowBytes, (height - y) * rowBytes), y * rowBytes);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
}

export function withCaptureTarget(THREE, renderer, width, height, draw) {
    const state = saveRendererState(renderer, THREE);
    const target = createCaptureTarget(THREE, width, height);
    try {
        renderer.setRenderTarget(target);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        draw();
        return readTargetPng(renderer, target, width, height);
    } finally {
        restoreRendererState(renderer, state);
        target.dispose();
    }
}
