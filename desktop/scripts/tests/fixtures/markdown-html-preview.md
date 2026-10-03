## HTML media preview

果然，跟随着 <u>Grok Bot</u> 和 <u>Muse</u>，以及 <u>**加粗下划线**</u>。

Literal code: `<u>keep these tags</u>`.

<video src="./markdown-preview.mp4" poster="./live-preview.svg" controls title="HTML video"></video>

<video controls title="Source child video">
  <source src="./markdown-preview.mp4" type="video/mp4">
</video>

![Markdown video](./markdown-preview.mp4)

After Markdown video first line. 这里应该落在点击的正文行。

你也可以在 Slack、Teams 给 dots 发送消息。

Wrapped paragraph after video: 这是用来验证自动换行之后点击位置的段落。无论文档中有多少个视频，点击某一行的文字，都应该把光标准确放在那个位置。This paragraph continues long enough to wrap in both a narrow pane and a wide full view, so clicking its final visual line also exercises the measured block positions after media previews.

![[markdown-preview.mp4|Obsidian video]]

After Obsidian video first line. 光标不应偏移到空白行。

![[live-preview.svg|Obsidian image]]

After Obsidian image. 图片和视频的键盘导航应一致。

```html
<u>literal underline</u>
<video src="./never-load.mp4"></video>
```
