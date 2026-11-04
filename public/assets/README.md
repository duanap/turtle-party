# 龟牌派对 · 透明 PNG 独立素材包

本素材包从统一视觉参考图中拆出独立的 PNG，包含 **86 张素材**，均具有 Alpha 透明通道。顶部/四周的浅色渐变背景已处理掉。`assets_contact_sheet.jpg` 是透明棋盘格预览；`reference_designs/` 是整页设计参考图（**非**透明素材）。

## 文件夹与用途

- `branding/`：龟牌派对标志（内含文字，作为 LOGO 图片使用）。
- `tables/`：大型牌桌、紧凑牌桌、独立名牌、室内窗景装饰。
- `avatars/`：乌龟、猫、狗、兔、熊猫、猫头鹰、人物、机器人头像。
- `players/`：座位卡状态示范、4种无字玩家座位底板和可叠字的绿色名牌。
- `cards/`：红色及蓝色牌背、典型正面牌、**无字扑克牌正面底板**。
- `buttons/`：按钮带字视觉样例；推荐用 `button_gold_blank_filled.png` / `button_green_blank_filled.png` / `button_cream_blank_filled.png` 无字底板。
- `icons/`：设置、音效、帮助和退出图标。
- `mascots/`：快乐、思考、墨镜、晕倒乌龟。
- `effects/`：选牌抬起、翻牌、配对、烟花和庆祝素材。
- `panels/`：创建、加入、结算和规则弹窗样例，以及空白可编辑弹窗底板 `modal_blank_cream.png`。
- `status/`：当前回合、倒计时和网络状态示例。
- `reference_designs/`：原效果图，供 Codex 对照排版、颜色和阴影。
- `assets.json`：机器可读路径、描述及图像尺寸。

## 给 Codex 的使用指引

1. 把这些 PNG 复制到 `public/assets/` 下，**保持文件夹结构**。
2. 对牌桌、头像和图标使用独立 `<img>` 或 CSS 背景；不要再用 CSS 重画素材中的插画。
3. **玩家昵称、剩余牌数、按钮文案、倒计时、房间号应由 HTML/CSS 实时渲染**，不要依赖图片里写死的示例文字。建议以 `buttons/button_gold_blank_filled.png` / `button_green_blank_filled.png` 为底板，文字覆盖其上。
4. **52 张游戏牌建议由 `cards/face_blank_css_overlay.png` 作为底板，JavaScript/CSS 动态添加点数和花色**；插画牌面只是视觉示范。每张牌用独立 DOM 元素实现翻转、移动和点击，状态由服务器控制。
5. 贴图是矢量感插画的位图，尺寸以 `assets.json` 为准。不要在小屏下把已拼好的整页效果图缩小作为游戏界面。
6. 某些发光素材/插画边缘可能有非常少量的生成残影；本包已经清理半透明底色，但建议在实际绿色毛毡/木纹背景上做最终 QA。
7. `reference_designs/` 用于 UI 对齐与色彩参考，不应直接作为交互界面的整页背景（里面包含不可交互的文字和扑克牌）。

## HTML 示例

```html
<div class="game-table">
  <img class="table-art" src="/assets/tables/table_felt_wood_large.png" alt="">
  <div class="players"><!-- 用 JS 渲染座位 + avatar PNG --></div>
  <div class="draw-zone"><!-- 用 JS 渲染单张牌，不使用整页截图 --></div>
  <div class="my-cards"><!-- 可拖拽的游戏手牌 --></div>
</div>
<button class="button-art"><span>快速开始</span></button>
```

```css
.game-table { position: relative; width: min(100%, 1100px); aspect-ratio: 1.85; }
.table-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; pointer-events: none; }
.button-art { background: url('/assets/buttons/blank_button_cream.png') center / 100% 100% no-repeat; border: 0; padding: 14px 40px; cursor: pointer; }
```

本包是**静态资源**，不是可直接运行的游戏源码。按钮示例中包含了演示文字；如果要支持不同昵称/状态，应使用无字底板 + 动态 DOM，而不是把示例文字作为实际 UI 文案。
