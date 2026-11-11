# meme-library

表情包图库：按角色分文件夹，用 `index.json` 打标记，手机相册页和浏览器扩展都读同一份目录。

## 相册页

打开 GitHub Pages 就能看：按角色筛、按类型（动图 / 静态）筛、按标签搜，点开看大图，长按保存到手机相册。

列表里显示的是轻量缩略图，打开快；点开后才加载原图动图。

## 打标签和不喜欢

相册页里点开一张图可以自己加标签，也可以点“不喜欢，下次删掉”。

这两个操作先存在手机浏览器本地，底下会出现一条提示，点“复制给 Konata”把改动发给 Konata，由 Konata 写进 `index.json`、从仓库里删掉不喜欢的图。

## 结构

```
stickers/
  <角色>/            # 一个角色一个文件夹，比如 naiwa、blue-fish
    <名字>.gif
thumbs/
  <角色>/            # 列表用的轻量缩略图（首帧，JPEG）
    <名字>.jpg
index.json           # 总目录：每条记录带角色、标签、来源、日期、MD5
index.html           # 手机相册页
```

新角色直接加一个文件夹，再往 `index.json` 里加记录，结构不用动。角色的中文名写在 `index.json` 的 `characters` 里。

## index.json 字段

每条记录：`id`、`file`（相对路径）、`thumb`（缩略图）、`character`（角色）、`tags`（标签数组）、`source`（来源）、`added`（日期）、`format`、`width`、`height`、`animated`、`md5`（去重用）。

## 更新流程

1. 搜到新表情包后先算 MD5，跟 `index.json` 里的比对，重复的不要。
2. 没重复的放进对应角色的文件夹，生成一张缩略图。
3. 在 `index.json` 里加一条记录，带上标签。
4. 推上去，扩展和手机相册下次打开就自动看到了。

注意：有些图看着是 .gif 后缀，实际内容是 JPEG 静态图（上传时被转过），动图数据已经丢了，恢复不了，需要重新找原图或重新发。

## 来源

- `memecub`：memecub.com 搜索接口
- `moezone`：萌の领域
- `orliss/nailong`：GitHub Orliss/nailong 仓库
- `user-sample`：用户自己发的样图
