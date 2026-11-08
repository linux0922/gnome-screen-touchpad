# 屏幕触控板 · GNOME Screen Touchpad

把触摸屏的一小块区域变成悬浮触控板。手指在触控板上滑动时，系统鼠标指针会跟着移动，方便在 Ubuntu 平板和二合一电脑上操作小按钮、拖动窗口和选中文本。触控板外的区域仍可直接触摸。

## 安装

适用于带触摸屏的 **GNOME Shell 50 / Wayland**。已在 Ubuntu 26.04.1 LTS 验证，安装到当前用户，无需管理员权限。

1. 从 [GitHub Releases 下载最新版安装包](https://github.com/linux0922/gnome-screen-touchpad/releases/latest/download/screen-touchpad%40codex.local.shell-extension.zip)。
2. 在安装包所在目录打开终端，执行以下命令。首次安装和升级使用同一条命令。

   ```sh
   gnome-extensions install --force ./screen-touchpad@codex.local.shell-extension.zip
   ```

3. 注销并重新登录。首次安装时启用扩展。

   ```sh
   gnome-extensions enable screen-touchpad@codex.local
   ```

4. 点击桌面右上角的系统状态区域，在「快捷设置」里开启「屏幕触控板」。

各版本的安装包和更新记录见 [Releases](https://github.com/linux0922/gnome-screen-touchpad/releases)。

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

打开触控板面板时会保留当前屏幕方向。首次使用触控区域时才启用虚拟鼠标，接管自动旋转时会等待新的稳定传感器读数。

自动旋转补偿适用于有可用加速度计且只启用一块内置屏幕的设备。如果 GNOME 隐藏了自动旋转开关，扩展会在快捷设置中补上「自动旋转」开关。该开关与子菜单中的「锁定屏幕旋转」共用系统设置。

## 从源码构建

扩展源码在 `extension/`，构建产物生成到 `dist/`。在仓库根目录运行以下命令，需要 `make` 和 `gnome-extensions`。

```sh
make pack
```

用 `make install` 可以构建并安装到当前用户，之后按上面的步骤重新登录并启用扩展。

## 停用或卸载

```sh
gnome-extensions disable screen-touchpad@codex.local
gnome-extensions uninstall screen-touchpad@codex.local
```

如果遇到问题，欢迎提交 Issue，附上 Ubuntu 版本、GNOME Shell 版本、会话类型以及复现步骤。旋转相关问题也可附上触屏设备型号和外接显示器情况。
