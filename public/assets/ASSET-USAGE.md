# 运行界面的素材对应关系

来源：用户提供的 turtle-party-assets-transparent-86pcs.zip。整包保持目录结构解压，95 个原始文件已逐一校验 SHA-256，与压缩包字节一致。PNG 未重新抠图、重新绘制、转码或改尺寸。

## 当前实际接入

| 界面元素 | 素材 | 动态内容 |
| --- | --- | --- |
| 房间窗景与主牌桌 | tables/room_window_scenery.png、table_felt_wood_compact.png | 可适配尺寸的前景布局 |
| 游戏标志 | branding/turtle_party_logo.png | 语义标题与可访问名称 |
| 玩家头像 | avatars 下的独立圆形头像 PNG | 按玩家标识稳定选择 |
| 座位状态 | players/player_card_blank_default、active、target、escaped.png | 昵称、牌数、行动/托管状态 |
| 按钮 | buttons/button_gold_blank_filled.png、button_cream_blank_filled.png | HTML 按钮文案与真实事件 |
| 规则及功能弹窗 | panels/modal_blank_cream.png | HTML 标题、规则、输入框和设置 |
| 房间号与计时底板 | tables/panel_wood_oval_blank.png | 房间号、网络、当前回合、倒计时和统计 |
| 游戏牌 | cards/face_blank_css_overlay.png、back_red_single.png、back_blue_single.png、back_blue_selected.png | 每张独立 DOM 的真实点数、花色、牌位 |
| 功能图标 | icons/help.png、settings.png、leave.png | 可访问标签及按钮事件 |
| 装饰与配对反馈 | mascots/turtle_happy.png、turtle_thinking.png、effects/gold_sparkles.png | 动画由服务端结果驱动 |

CSS 用于定位、尺寸、排版、滚动与变换，不再绘制替代牌桌、头像、标志或装饰。动态文字叠加在无字底板上；逐张扑克牌继续执行选中、翻转、入手和配对动画。

## 保留作参考的素材

reference_designs、带固定文案的按钮/状态/玩家示例、完整面板示例以及配对整组示例均随包保留，用于对照。运行界面不引用这些整页或整组效果图，不会把示例昵称、房间号、牌数或倒计时当作真实数据。

原始 README.md 与 assets.json 保持不变。本文件是项目的接入记录。
