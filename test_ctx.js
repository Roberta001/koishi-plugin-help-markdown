const { Context, Command } = require('koishi');

const root = new Context();
const pluginA = {
    name: 'plugin-a',
    apply(ctx) {
        ctx.command('foo');
    }
};
const pluginB = {
    name: 'plugin-b',
    apply(ctx) {
        ctx.command('bar');
        
        ctx.$commander._commandList.forEach(cmd => {
            console.log("Before: ", cmd.name, cmd.ctx.name);
            cmd[Context.current] = ctx;
            console.log("After: ", cmd.name, cmd.ctx.name);
        });
    }
};

root.plugin(pluginA);
root.plugin(pluginB);
root.start();
