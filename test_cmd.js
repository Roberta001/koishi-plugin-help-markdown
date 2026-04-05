const { Context } = require('koishi');

const ctx = new Context();

ctx.command('foo', 'bar');
ctx.command('baz', 'qux');

const list = ctx.$commander._commandList.filter(cmd => cmd.parent === null);
console.log('Total roots:', list.length);

const valid = list.filter(cmd => Object.keys(cmd._aliases).length);
console.log('Valid:', valid.length);
