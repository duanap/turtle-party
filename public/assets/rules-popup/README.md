# 龟牌派对 · 游戏规则弹窗透明素材

本资源包拆分自你提供的“游戏规则”弹窗视觉参考，并使用其风格生成了高清可复用素材。**每张图片均为 RGBA 透明 PNG**：外部区域透明，弹窗内部米色面板本身不透明。

## 目录

- `assets/panel/`：独立米色弹窗底板、完整参考图。
- `assets/header/`：木质“游戏规则”标题牌（带文字/无文字）。
- `assets/illustrations/`：四个独立规则插画，分别为移除一张牌、相同点数配对、轮流抽牌、最后的乌龟。
- `assets/decor/`：两侧叶片、浅金分隔线。
- `assets/text/`：可选的四张原风格中文文字 PNG。
- `assets/templates/`：已经组装好的 **无字空白弹窗底图**，可由前端覆盖全部文字和插画。
- `preview.png`：检查透明效果与素材的索引图（预览底色为棋盘格，不属于素材）。
- `manifest.json`：文件名称、用途和尺寸。

## 在 Codex / 网页项目中使用

推荐将 `assets/` 放到项目 `public/assets/rules-popup/` 下。使用 `popup_template_no_text.png` 作为容器背景，再通过 HTML 叠加规则标题与各项内容；或者单独组合 `popup_panel_blank.png`、`header_title_blank.png`、左右叶片、分割线。

应由 DOM 动态展示的文字：

1. 随机移除一张牌
2. 相同点数自动配对
3. 轮流抽牌
4. 最后留乌龟者失败

```html
<div class="rules-dialog" role="dialog" aria-label="游戏规则">
  <h2>游戏规则</h2>
  <div class="rules-row"><img src="/assets/rules-popup/illustrations/rule01_remove_one_card.png" alt=""><span>随机移除一张牌</span></div>
  <div class="rules-row"><img src="/assets/rules-popup/illustrations/rule02_match_pairs.png" alt=""><span>相同点数自动配对</span></div>
  <div class="rules-row"><img src="/assets/rules-popup/illustrations/rule03_draw_card.png" alt=""><span>轮流抽牌</span></div>
  <div class="rules-row"><img src="/assets/rules-popup/illustrations/rule04_sleepy_turtle.png" alt=""><span>最后留乌龟者失败</span></div>
</div>
```

```css
.rules-dialog {
  position: relative;
  width: min(90vw, 440px);
  aspect-ratio: 618 / 828;
  background: url('/assets/rules-popup/templates/popup_template_no_text.png') center / 100% 100% no-repeat;
  padding: 19% 9% 9%;
  display: flex; flex-direction: column; justify-content: space-around;
  box-sizing: border-box;
  color: #4b2412;
}
.rules-dialog h2 {
  position: absolute; top: 3.5%; left: 0; right: 0; margin: 0;
  text-align:center; font-weight:900; font-size: clamp(20px, 5vw, 30px);
  color: #fff3d6; text-shadow: 1px 2px 2px #5d2d15;
}
.rules-row { display:flex; align-items:center; gap: 4%; flex:1; min-height:0; }
.rules-row img { width:34%; height:80%; object-fit:contain; }
.rules-row span { flex:1; font-size:clamp(12px, 3.3vw, 19px); font-weight:800; white-space:nowrap; }
```

**注意**：生成的高清插画是按上传原图风格重制、分层整理的，并非无损还原的原始设计工程。面板和图标外侧透明，少量柔和阴影保留半透明像素。`text/` 内是图片文字，正式网页优先使用 HTML 字体渲染，避免移动端缩放发糊。
