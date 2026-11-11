# meme-library

表情包图库：按角色分文件夹，用 `index.json` 打标记，手机相册页和浏览器扩展都读同一份目录。

## 相册页

打开 GitHub Pages 就能看：按角色筛、按标签搜，点开看大图，长按保存到手机相册。

## 结构

```
stickers/
  <角色>/            # 一个角色一个文件夹，比如 naiwa、blue-fish
    <名字>.gif
index.json           # 总目录：每条记录带角色、标签、来源、日期、MD5
index.html           # 手机相册页
```

新角色直接加一个文件夹，再往 `index.json` 里加记录，结构不用动。

## index.json 字段

每条记录：`id`、`file`（相对路径）、`character`（角色）、`tags`（标签数组）、`source`（来源）、`added`（日期）、`format`、`width`、`height`、`animated`、`md5`（去重用）。

## 更新流程

1. 搜到新表情包后先算 MD5，跟 `index.json` 里的比对，重复的不要。
2. 没重复的放进对应角色的文件夹。
3. 在 `index.json` 里加一条记录，带上标签。
4. 推上去，扩展和手机相册下次打开就自动看到了。

## 来源

- `memecub`：memecub.com 搜索接口
- `moezone`：萌の领域
- `orliss/nailong`：GitHub Orliss/nailong 仓库
- `user-sample`：用户自己发的样图
