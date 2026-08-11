# PIXI GIF Runtime Lab

一个用于验证“大 GIF 下载到客户端后解码并通过 PIXI.js 播放”的浏览器 Demo。

[在线 Demo](https://horan-ding.github.io/pixi-gif-client-decoding-demo/)

## 实现方式

```text
单个 GIF 文件
  -> Web Worker fetch
  -> omggif 增量解码
  -> RGBA 合成缓冲（处理 disposal 2/3）
  -> 最多提前准备一个 ImageBitmap
  -> 主线程 CanvasSource
  -> 同一个 PIXI Texture 调用 source.update()
  -> WebGL 2 渲染
```

这里不会像 `PIXI.AnimatedSprite` 或 `@pixi/gif` 那样把全部 GIF 帧预先展开成一组 Texture。播放器始终只有一个 Sprite 和一个可变 Texture；代价是每帧仍需要将解码后的像素上传到 GPU。

GitHub connector 对单次文件写入有请求体限制，因此源码仓库将每个 GIF 仅按传输字节分片。`prebuild` 在 Actions 中先按顺序重建原始 `.GIF`，Pages 产物和浏览器运行时仍然是一张 GIF 对应一个 URL。分片不是预解码帧，也不会增加 PIXI Texture 数量。

## 性能指标

- `Worker 解码 P95`：最近 120 帧的 GIF 解码与合成耗时。
- `主线程压力`：帧拷贝/纹理更新耗时与事件循环延迟形成的浏览器侧代理值，不是操作系统 CPU 利用率。
- `GPU 单帧 P95`：通过 `EXT_disjoint_timer_query_webgl2` 获取的 GPU 帧耗时；不等同于系统 GPU 利用率，不支持该扩展时显示 `N/A`。
- `JS Heap`：Chromium 的非标准 `performance.memory`；其他浏览器可能不提供。
- `工作集估算`：压缩 GIF、Worker RGBA 合成缓冲、OffscreenCanvas、传输帧、主线程 Canvas 和 GPU RGBA 纹理的保守估算。

浏览器没有标准 API 能读取当前标签页对应的系统 CPU/GPU 利用率，因此 Demo 不会把代理指标标成系统利用率。

## 本地运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

## 样本

| 文件 | 尺寸 | 压缩体积 | 帧数 | 时长 |
| --- | ---: | ---: | ---: | ---: |
| `image31.GIF` | 1910 x 942 | 20.6 MB | 594 | 52.48 s |
| `image32.GIF` | 1910 x 942 | 8.7 MB | 1315 | 126.18 s |

## 技术边界

- 解码仍然发生在客户端，低端设备会承担 CPU、内存和耗电成本。
- GIF 像素每帧需要重新上传至 GPU；WebGL 本身不能直接解码 GIF 压缩流。
- 单纹理路径降低了全量帧 Texture 的峰值内存，但不能消除逐帧解码和像素上传成本。
- Demo 使用一个 Worker 和一帧 lookahead，适合作为可行性/性能基线，不代表最终 SDK 资源调度方案。
