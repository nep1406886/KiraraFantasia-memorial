# 《きららファンタジア》关服纪念画师帖素材

本目录整理了游戏于 2023 年 2 月 28 日 15:59（日本时间）停止运营前后（含关服后补发），由参战作品作者或相关创作者本人发布、明确提及关服或致谢且带图片的公开 X 帖文。

## 内容

- `artworks.json`：主数据，推荐网页通过 `fetch()` 读取。
- `artworks.js`：与 JSON 内容相同，赋值给全局变量 `kirafanShutdownArtworks`，适合当前项目直接用 `<script>` 引入或从本地文件打开。
- `images/`：从 `pbs.twimg.com` 下载的原始尺寸附件，共 10 张。

当前收录 10 位创作者、10 条带图帖文：蒼樹うめ、はんざわかおり、原悠衣、卯花つかさ、こうのす、千葉サドル、うちのまいこ、浜弓場双、如意自在、篤見唯子。

## 字段说明

- `textJa`：帖文日文原文。
- `textZh`：为网页展示整理的简体中文翻译，不替代原文。
- `postUrl`：原帖链接。
- `timing`：仅在需要强调相对关服时间时使用，例如 `post-shutdown` 表示关服后补发。
- `mediaNote`：说明图片是否为新绘、旧图重用、草稿或游戏截图。
- `images[].path`：相对本目录的本地图片路径。
- `images[].mediaKind`：建议网页据此筛选图片类别。
- `images[].sha256`：用于检查本地文件是否被改变。

网页从站点根目录引用图片时，可使用：

```js
fetch("asset/shutdown-artworks/artworks.json")
  .then(function (response) { return response.json(); })
  .then(function (data) {
    var firstImage = "asset/shutdown-artworks/" + data.items[0].images[0].path;
    console.log(firstImage);
  });
```

若页面直接以 `file://` 打开，浏览器可能禁止 `fetch()`；此时可引入 `artworks.js`：

```html
<script src="asset/shutdown-artworks/artworks.js"></script>
```

## 核验与使用说明

原帖、作者、日期、正文和图片通过 X 公开帖文元数据、X oEmbed，以及同期的 [Posfie 关系者反应存档](https://posfie.com/@UDONisGOD8432/p/N3MoBme)交叉核对。荒井チェリー的告别帖虽仍见于同期存档，但原帖及原始附件现已无法读取，因此没有收入本素材包。

本目录只做资料整理。图片版权归原作者及相关权利方所有；将图片发布到公开网页前，请自行确认授权、引用和署名要求。原帖可能被删除或修改，因此页面应优先保留作者名和原帖链接，不要把本地副本表述为授权再发布。
