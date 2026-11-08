# 屏幕触控板 · GNOME Screen Touchpad

把触摸屏的一小块区域变成悬浮触控板。手指在触控板上滑动时，系统鼠标指针会跟着移动，方便在 Ubuntu 平板和二合一电脑上操作小按钮、拖动窗口和选中文本。触控板外的区域仍可直接触摸。

## 兼容性

- 在 **Ubuntu 26.04.1 LTS、GNOME Shell 50.1、Wayland** 环境验证过。扩展声明支持 GNOME Shell 50，使用前可运行 `gnome-shell --version` 和 `echo "$XDG_SESSION_TYPE"` 检查。
- 需要触摸屏。安装到当前用户，无需管理员权限。
- 自动旋转补偿适用于带有可用加速度计、且只启用一块内置屏幕的设备。GNOME 自己能够控制旋转时，由 GNOME 接管。

## 安装

1. [下载扩展安装包](downloads/screen-touchpad%40codex.local.shell-extension.zip?raw=1)，在下载目录打开终端。
2. 运行以下命令。

   ```sh
   gnome-extensions install --force ./screen-touchpad@codex.local.shell-extension.zip
   ```

3. 注销并重新登录，再启用扩展。

   ```sh
   gnome-extensions enable screen-touchpad@codex.local
   ```

4. 点击桌面右上角的系统状态区域，在「快捷设置」里开启「屏幕触控板」。

升级时用新版安装包重新执行安装命令，然后注销并重新登录。

## 操作方法

| 操作 | 手势或位置 |
| --- | --- |
| 移动鼠标 | 单指在触控区域滑动 |
| 左键 | 单指轻点，或点底部「左键」 |
| 右键 | 双指轻点，或点底部「右键」 |
| 双击 | 连续轻点两下 |
| 拖动 | 先轻点一下，第二下按住并移动，松手结束 |
| 滚动 | 在触控区域双指滑动，或在右侧「滚动」区单指上下滑动 |
| 移动触控板 | 拖动顶部标题栏 |
| 调整大小 | 拖动右下角的 `◢`。底部左右键随宽度一起伸缩 |
| 最小化与恢复 | 点顶部 `▁` 把触控板缩成小图标。拖动图标可移动它，轻点图标可恢复面板 |
| 调整透明度 | 点触控板顶部的齿轮，调整「不透明度」（50%–100%）。快捷设置子菜单也可调整 |
| 调整鼠标灵敏度 | 点齿轮，调整「鼠标灵敏度」（25%–200%，默认 100%）。此设置只影响触控板滑动时的指针速度 |
| 关闭触控板 | 点右上角 `×`，或关闭快捷设置开关 |

两项设置即时生效并自动保存。再点齿轮即可回到触控区。

触控板和最小化图标使用相同的不透明度。如果已启用兼容的 PAD-OSK 屏幕键盘（`erhai-osk@local`），两边也会同步，首次同步采用键盘当前的设置。

打开触控板面板时会保留当前屏幕方向。首次使用触控区域时才启用虚拟鼠标；接管自动旋转时会保留已有方向，并等待新的稳定传感器读数。如果 GNOME 隐藏了自动旋转开关，且设备满足上面的传感器和屏幕条件，扩展会在快捷设置中补上「自动旋转」开关。这个开关与子菜单中的「锁定屏幕旋转」共用系统设置。

## 从源码打包

在仓库根目录执行以下命令，安装包会生成到 `downloads/`。

```sh
gnome-extensions pack --force --extra-source=rotation.js --out-dir=downloads extension
```

## 停用或卸载

```sh
gnome-extensions disable screen-touchpad@codex.local
gnome-extensions uninstall screen-touchpad@codex.local
```

如果遇到问题，欢迎提交 Issue，附上 Ubuntu 版本、GNOME Shell 版本、会话类型以及复现步骤。旋转相关问题也可附上触屏设备型号和外接显示器情况。
