# Windows 活体验证脚本（可选）

这些是"在原机器上真的操作 Zotero 阅读器"用的原始 Win32 鼠标脚本，
**坐标是相对那台机器写的**，换机器必须重新量。

| 脚本 | 用途 |
|---|---|
| `drag3.ps1 x1 y1 x2 y2` | 慢速拖拽划选（pdf.js 需要逐步 mousemove，快了会漏字符） |
| `drag2d.ps1 x1 y1 x2 y2` | 快速拖拽（拖动浮窗/调整大小） |
| `movewheel.ps1 x y delta` | 在指定位置滚轮 |
| `snap.ps1 x y w h out` | 截屏到文件 |
| `rightclick.ps1 x y` | 右键 |

⚠️ `.ps1` 必须**保持 ASCII 注释**：带非 ASCII 又没有 BOM 时，
Windows PowerShell 按 ANSI 解析 → 脚本静默失败、`$args` 全空。

怎么把 PDF 坐标换算成屏幕坐标（原机器实测做法）：
1. 截全屏 → 用暗像素找出**文字列带**的 x 范围（左列/右列各一条）；
2. 与 pymupdf 读出的该页列坐标比 → 得 `scale`；
3. 再由任一处已知文字位置定 `X0/Y0`；之后 `screen = X0 + pdf*scale`。
