---
title: JavaScript知识学习
abbrlink: learning-about-javascript
date: 2026-11-15 22:45:00
series: 写作与前端基础
series_order: 2
tags:
  - 前端
  - 知识学习
  - 总结
categories:
  - 教程
cover: /images/selection1.jpg
description: 关于 JavaScript 的基本知识：语法、函数、数组与对象、DOM 事件、异步请求
---

## 写在前面

上一篇 [HTML知识学习](/posts/learning-about-html/) 解决的是「页面上有什么」，CSS 解决「长什么样」，而 **JavaScript 负责「能干什么」**。

一句话概括：HTML 是骨架，CSS 是皮肤，JS 是肌肉和神经。

JS 是一门**解释型、弱类型、单线程**的脚本语言，跑在浏览器里的引擎（Chrome 的 V8、Firefox 的 SpiderMonkey）上，后来 Node.js 把它带到了服务端。

---

**JS 能做的事**

1. 操作页面：改文字、改样式、增删元素。
2. 响应用户：点击、输入、滚动、拖拽。
3. 发请求：向服务器拿数据，局部刷新页面（AJAX / fetch）。
4. 存数据：`localStorage`、`Cookie`、`IndexedDB`。
5. 写工具与后端：命令行脚本、爬虫、Node 服务。

## 三种引入方式

```html
<!-- 1. 内联：写在标签事件里，只适合写 demo -->
<button onclick="alert('点我')">点我</button>

<!-- 2. 内部脚本：放在 body 末尾，保证 DOM 已存在 -->
<script>
  console.log('hello')
</script>

<!-- 3. 外部脚本：最推荐，可缓存、可复用 -->
<script src="./js/main.js"></script>

<!-- 4. 外部脚本 + defer：等 HTML 解析完再按顺序执行 -->
<script src="./js/main.js" defer></script>
```

---

**`defer` 和 `async` 的区别**

| 属性    | 下载        | 执行时机                         | 顺序           |
| :------ | :---------- | :------------------------------- | :------------- |
| 无      | 同步阻塞    | 下载完立即执行                   | 按书写顺序     |
| `defer` | 异步        | HTML 解析完、`DOMContentLoaded` 前 | 严格按书写顺序 |
| `async` | 异步        | 下载完立即执行，可能打断解析     | 谁先下完谁先跑 |

> 需要操作 DOM 的脚本，优先 `defer`；独立的统计脚本（不依赖别人、别人也不依赖它）才用 `async`。

## 变量声明

```js
var  a = 1   // 老写法，现在基本不用
let  b = 2   // 需要重新赋值时用
const c = 3  // 不需要重新赋值时用，默认选它
```

| 关键字  | 作用域     | 能否重复声明 | 能否重新赋值 | 提升后初始值 |
| :------ | :--------- | :----------- | :----------- | :----------- |
| `var`   | 函数作用域 | 可以         | 可以         | `undefined`  |
| `let`   | 块级作用域 | 不可以       | 可以         | 暂时性死区   |
| `const` | 块级作用域 | 不可以       | 不可以       | 暂时性死区   |

> `const` 只锁「引用不变」，对象和数组里面的内容照样能改：
> `const arr = [1]; arr.push(2)` 是合法的，`arr = []` 才会报错。

## 数据类型

**基本类型（7 种）**

| 类型        | 例子              | 说明                       |
| :---------- | :---------------- | :------------------------- |
| `string`    | `'abc'`           | 字符串，单双引号都行       |
| `number`    | `1`、`3.14`、`NaN` | 整数和小数不分家           |
| `boolean`   | `true`、`false`   | 布尔值                     |
| `null`      | `null`            | 空值，人为赋值             |
| `undefined` | `undefined`       | 未定义，声明了但没赋值     |
| `symbol`    | `Symbol('id')`    | 独一无二的值，做对象键     |
| `bigint`    | `10n`             | 超大整数                   |

**引用类型**：`object`，包括数组 `Array`、函数 `Function`、日期 `Date`、正则 `RegExp` 等。

```js
typeof 'abc'      // 'string'
typeof 1          // 'number'
typeof true       // 'boolean'
typeof undefined  // 'undefined'
typeof null       // 'object'  ← 历史遗留的坑
typeof []         // 'object'  ← 数组也是 object
typeof function(){}// 'function'
Array.isArray([]) // true，判断数组用这个
```

---

**类型转换**

```js
String(123)      // '123'
Number('12px')   // NaN
parseInt('12px') // 12，能抓前缀数字
parseFloat('3.14m') // 3.14
Boolean('')      // false

// 假值一共只有 7 个：false、0、-0、0n、''、null、undefined、NaN
if ([]) console.log('空数组是真值') // 会打印
```

> 面试常问的浮点误差：`0.1 + 0.2 === 0.3` 是 `false`（结果 `0.30000000000000004`）。比较小数用 `Math.abs(a - b) < 1e-9`。

**模板字符串**

```js
const name = '小明'
const age = 18
console.log(`${name}今年${age}岁`) // 反引号，可以换行，可以嵌表达式
```

## 运算符

```js
10 / 3      // 3.3333...  没有整除
10 % 3      // 1  取余
2 ** 10     // 1024  幂
'1' + 1     // '11'  加号遇到字符串变成拼接
'1' - 1     // 0     减号会强制转数字
```

**`==` 和 `===`**

```js
1 == '1'    // true   会做隐式类型转换
1 === '1'   // false  类型不同直接不等
null == undefined  // true
null === undefined // false
NaN === NaN        // false，判断用 Number.isNaN(x)
```

> 结论：日常一律用 `===`，只有判断 `x == null` 这一个场景可以用 `==`（一次同时判断 null 和 undefined）。

**逻辑与空值处理**

```js
const a = 0
a || '默认值'   // '默认值'  ← 0 是假值，被吞掉了
a ?? '默认值'   // 0         ← 空值合并，只有 null/undefined 才兜底

const user = { profile: { name: '小明' } }
user?.profile?.name    // '小明'
user?.account?.name    // undefined，不会报错

obj.name ??= '匿名'    // 只有 name 是 null/undefined 时才赋值
```

## 流程控制

```js
if (score >= 90) {
  console.log('优秀')
} else if (score >= 60) {
  console.log('及格')
} else {
  console.log('不及格')
}

// switch 用的是 === 严格比较，别忘 break
switch (type) {
  case 'a':
    console.log('A')
    break
  case 'b':
  case 'c':
    console.log('B 或 C')
    break
  default:
    console.log('其他')
}

// 三元：只适合很短的分支
const label = age >= 18 ? '成年' : '未成年'
```

**循环**

```js
for (let i = 0; i < 3; i++) console.log(i)

const arr = ['a', 'b', 'c']
for (const item of arr) console.log(item)      // 遍历值（数组、字符串、Map、Set）
arr.forEach((item, index) => console.log(index, item)) // 不能 break

const obj = { x: 1, y: 2 }
for (const key in obj) console.log(key, obj[key]) // 遍历键，别拿它遍历数组

let n = 0
while (n < 3) n++
```

## 函数

```js
// 1. 函数声明：有提升，可以先调用后定义
function add(a, b = 1) {
  return a + b
}

// 2. 函数表达式：赋值给变量，没有提升
const mul = function (a, b) {
  return a * b
}

// 3. 箭头函数：单表达式可省 return
const div = (a, b) => a / b
const obj = () => ({ ok: true })   // 直接返回对象要套小括号

// 4. 剩余参数：把多余的实参收成数组
const sum = (...nums) => nums.reduce((s, n) => s + n, 0)
sum(1, 2, 3) // 6

// 5. 展开运算符：把数组/对象摊开
Math.max(...[1, 5, 3])        // 5
const copy = { ...user, age: 20 }
```

> **箭头函数和普通函数最大的区别**：箭头函数没有自己的 `this`，它继承外层作用域；也没有 `arguments`，不能当构造函数 `new`。

**作用域与闭包**

```js
function counter() {
  let n = 0          // 外部拿不到 n
  return () => ++n   // 但返回的函数一直记着它
}

const next = counter()
next() // 1
next() // 2
```

闭包 = 函数 + 它出生时所在的作用域。常见用途：计数器、防抖节流、模块私有变量。

## 数组

```js
const arr = [3, 1, 2]
arr.length      // 3
arr[0]          // 3，下标从 0 开始
arr.at(-1)      // 2，取最后一个
```

**会改原数组的方法**

| 方法            | 作用                     | 返回值       |
| :-------------- | :----------------------- | :----------- |
| `push(x)`       | 末尾添加                 | 新长度       |
| `pop()`         | 末尾删除                 | 被删的元素   |
| `unshift(x)`    | 开头添加                 | 新长度       |
| `shift()`       | 开头删除                 | 被删的元素   |
| `splice(i, n)`  | 从 i 开始删 n 个，可插入 | 被删元素数组 |
| `reverse()`     | 反转                     | 原数组       |
| `sort()`        | 排序                     | 原数组       |

**不改原数组的方法**

| 方法                  | 作用                       |
| :-------------------- | :------------------------- |
| `slice(start, end)`   | 截取，含头不含尾           |
| `concat(...)`         | 合并                       |
| `join('-')`           | 拼成字符串                 |
| `includes(x)`         | 是否包含                   |
| `indexOf(x)`          | 下标，找不到返回 -1        |
| `flat(depth)`         | 拍平                       |

**遍历与函数式方法（重点）**

```js
const nums = [1, 2, 3, 4, 5]

nums.map(n => n * 2)            // [2,4,6,8,10]  一对一映射
nums.filter(n => n % 2 === 0)   // [2,4]         过滤
nums.find(n => n > 3)           // 4             找第一个
nums.findIndex(n => n > 3)      // 3             找下标
nums.some(n => n > 4)           // true          存在一个
nums.every(n => n > 0)          // true          全部满足
nums.reduce((sum, n) => sum + n, 0) // 15        归约求和
```

> 排序的坑：`sort()` 默认按**字符串**比较，`[10, 9, 1].sort()` 得到 `[1, 10, 9]`。数字排序必须写 `arr.sort((a, b) => a - b)`。

## 对象

```js
const user = {
  name: '小明',
  age: 18,
  say() {
    return `我是${this.name}`
  },
}

user.name        // 点语法
user['name']     // 方括号，键是变量时只能用这个
user.email = 'a@b.c'  // 直接加属性
delete user.email
'name' in user   // true
```

**解构、展开、遍历**

```js
const { name, age = 0, ...rest } = user   // 解构 + 默认值 + 收集剩余

const clone = { ...user }                 // 浅拷贝
const merged = { ...user, age: 20 }       // 覆盖字段

Object.keys(user)    // ['name', 'age', 'say']
Object.values(user)
Object.entries(user) // [['name','小明'], ...]
```

**和 JSON 互转**

```js
JSON.stringify({ a: 1 })   // '{"a":1}'
JSON.parse('{"a":1}')      // {a: 1}
```

> 注意：`JSON.stringify` 会丢掉 `undefined`、函数和 `Symbol`，也不能处理循环引用。

## DOM 操作

DOM 就是把 HTML 解析成的一棵节点树，JS 通过 `document` 去访问它。

**查找元素**

```js
document.getElementById('app')        // 单个，最快
document.querySelector('.item')       // 第一个匹配，写 CSS 选择器
document.querySelectorAll('.item')    // 全部，NodeList，可以用 forEach
document.querySelectorAll('.item')[0] // 转成数组：[...document.querySelectorAll('.item')]
```

**改内容、属性、样式**

```js
const box = document.querySelector('.box')

box.textContent = '纯文本'            // 只当文本，安全
box.innerHTML = '<strong>富文本</strong>' // 会解析标签
box.setAttribute('data-id', '1')
box.dataset.id                      // '1'
box.style.color = 'red'             // 行内样式，驼峰命名
box.classList.add('active')
box.classList.remove('active')
box.classList.toggle('active')      // 有就删，没有就加
box.classList.contains('active')    // true / false
```

> 用户输入的内容永远用 `textContent` 塞进去。`innerHTML = 用户输入` 等于把 XSS 漏洞直接开在页面上。

**创建、插入、删除节点**

```js
const li = document.createElement('li')
li.textContent = '新条目'

list.append(li)        // 放最后
list.prepend(li)       // 放最前
li.remove()            // 删自己
```

## 事件

```js
const btn = document.querySelector('#btn')

btn.addEventListener('click', (e) => {
  e.preventDefault()          // 阻止默认行为（如链接跳转、表单提交）
  e.stopPropagation()         // 阻止冒泡
  console.log(e.target)       // 真正被点到的元素
})
```

**常用事件**

| 事件         | 触发时机                   |
| :----------- | :------------------------- |
| `click`      | 点击                       |
| `input`      | 输入框内容变化（实时）     |
| `change`     | 失焦或选项改变后           |
| `submit`     | 表单提交                   |
| `keydown`    | 按下键盘                   |
| `scroll`     | 滚动                       |
| `DOMContentLoaded` | HTML 解析完成        |

**事件冒泡与事件委托**

点击子元素，事件会一层层往上冒到父元素。利用这点，可以把监听器挂在父级上统一处理：

```js
list.addEventListener('click', (e) => {
  if (!e.target.matches('li')) return
  e.target.classList.toggle('done')
})
```

好处：动态新增的 `li` 不用再单独绑事件，也省内存。

## 定时器

```js
const timer = setTimeout(() => {
  console.log('1 秒后执行一次')
}, 1000)
clearTimeout(timer)

const tick = setInterval(() => console.log('每秒一次'), 1000)
clearInterval(tick)
```

**一个防抖的例子**（输入停止 300ms 后才搜索）

```js
function debounce(fn, delay = 300) {
  let timer = null
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

input.addEventListener('input', debounce((e) => {
  console.log('搜索：', e.target.value)
}, 300))
```

## 异步

JS 是单线程的，遇到耗时的任务（网络请求、读文件）不能干等，于是有了异步。

**从回调到 Promise 到 async/await**

```js
// 老写法：回调地狱
getUser(id, (user) => {
  getOrders(user.id, (orders) => {
    getDetail(orders[0].id, (detail) => { /* ... */ })
  })
})

// Promise 链式
getUser(id)
  .then(user => getOrders(user.id))
  .then(orders => getDetail(orders[0].id))
  .catch(err => console.error(err))

// async / await：看起来像同步代码
async function load(id) {
  const user = await getUser(id)
  const orders = await getOrders(user.id)
  return getDetail(orders[0].id)
}
```

**fetch 发请求**

```js
async function getList() {
  try {
    const res = await fetch('/api/list')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return data
  } catch (err) {
    console.error('请求失败：', err)
    return []
  } finally {
    console.log('请求结束')
  }
}
```

> `fetch` 只有网络错误才 reject，**404 / 500 不会进 catch**，必须自己判断 `res.ok`。

**并发请求**

```js
const [a, b] = await Promise.all([getA(), getB()])  // 全成功才返回
const first = await Promise.race([getA(), getB()])  // 谁快用谁
```

## 浏览器存储

```js
// localStorage：永久保存（除非手动清），只能存字符串
localStorage.setItem('theme', 'dark')
localStorage.getItem('theme')       // 'dark'
localStorage.removeItem('theme')
localStorage.clear()

// 存对象要先序列化
localStorage.setItem('user', JSON.stringify({ name: '小明' }))
const user = JSON.parse(localStorage.getItem('user') || '{}')

// sessionStorage：关掉标签页就没了，API 完全一样
```

> 存储上限约 5MB，同源共享，**不要存密码和 token 明文**（脚本能读到，容易被 XSS 偷走）。

## 小例子：待办清单

把上面这些串起来，一个能存住数据的待办：

```html
<form id="form">
  <input id="input" placeholder="输入待办，回车添加">
  <button>添加</button>
</form>
<ul id="todo"></ul>
```

```js
const form = document.querySelector('#form')
const input = document.querySelector('#input')
const list = document.querySelector('#todo')

let todos = JSON.parse(localStorage.getItem('todos') || '[]')

function save() {
  localStorage.setItem('todos', JSON.stringify(todos))
}

function render() {
  list.innerHTML = ''
  todos.forEach((text, index) => {
    const li = document.createElement('li')
    li.textContent = text
    li.dataset.index = index
    list.append(li)
  })
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const value = input.value.trim()
  if (!value) return
  todos.push(value)
  input.value = ''
  save()
  render()
})

// 事件委托：点哪条删哪条
list.addEventListener('click', (e) => {
  const index = e.target.dataset.index
  if (index === undefined) return
  todos.splice(Number(index), 1)
  save()
  render()
})

render()
```

## 常见坑

1. **`==` 隐式转换**：`'0' == false` 是 `true`，一律用 `===`。
2. **`typeof null` 是 `'object'`**：判断 null 用 `x === null`。
3. **浮点数精度**：`0.1 + 0.2 !== 0.3`，比较用差值。
4. **`sort()` 按字符串排**：数字排序必须传比较函数。
5. **数组/对象赋值是引用**：`const b = a` 之后改 `b` 会连带改 `a`，要复制用 `[...a]`、`{...a}` 或 `structuredClone(a)`。
6. **`const` 循环变量**：`for (var i...)` 配合异步会全部拿到最后一个 `i`，改用 `let`。
7. **`this` 指向**：普通函数的 `this` 看调用方式，箭头函数看定义位置。回调里想用外层 `this`，写箭头函数。
8. **忘了 `await`**：`const data = getList()` 拿到的是 Promise 不是数据。
9. **`innerHTML` 拼用户输入**：XSS 风险，用 `textContent`。

## 下一步学什么

- **模块化**：`import` / `export`，把代码拆成文件。
- **`class`**：语法糖，本质还是原型链。
- **正则表达式**：表单校验、文本处理。
- **`Promise` 深入**：手写一个 Promise，理解微任务队列。
- **框架**：Vue / React，把 DOM 操作交给框架，专注数据流。

> 学习路径建议：先把 DOM 和事件练熟（能不看文档写出增删改查），再补异步，最后碰框架。基础不牢直接上框架，遇到问题会不知道是框架的锅还是 JS 的锅。
