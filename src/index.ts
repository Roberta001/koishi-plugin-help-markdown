import { Context, Schema, Session, Command, Computed } from 'koishi'

declare module 'koishi' {
  namespace Command {
    interface Config {
      hideOptions?: boolean
      hidden?: Computed<boolean>
      params?: object
    }
  }
  namespace Argv {
    interface OptionConfig {
      hidden?: Computed<boolean>
      params?: object
    }
    interface OptionDeclaration {
      hidden?: Computed<boolean>
    }
  }
}

export const name = 'help-markdown'

export interface Config {
  enableQQNativeMarkdown: boolean
  enableQQInlineCmd: boolean
  filterMode: 'blacklist' | 'whitelist'
  pluginList: string[]
  pluginNameMapping: Record<string, string>
}

export const Config: Schema<Config> = Schema.object({
  enableQQNativeMarkdown: Schema.boolean().default(false).description('是否在 QQ 平台启用原生 Markdown 格式发送菜单'),
  enableQQInlineCmd: Schema.boolean().default(false).description('是否在 QQ 平台启用 mqqapi 快捷点击指令（仅在开启原生 Markdown 时生效）'),
  filterMode: Schema.union(['blacklist', 'whitelist']).default('blacklist').description('过滤模式：黑名单（排除指定插件）或白名单（仅包含指定插件）'),
  pluginList: Schema.array(String).default(['help-markdown']).description('黑名单或白名单的插件 ID / 插件名列表（默认为排除自己）'),
  pluginNameMapping: Schema.dict(String).default({}).description('给插件配置外显名映射（键为插件原始名/ID，值为外显名）'),
})

interface QQSendMessageRequest {
  content: string
  msg_type: 2
  msg_id?: string
  msg_seq?: number
  markdown: { content: string }
}

interface QQSessionBridge {
  sendMessage(channelId: string, data: QQSendMessageRequest): Promise<unknown>
  sendPrivateMessage(openid: string, data: QQSendMessageRequest): Promise<unknown>
}

async function sendTextOrMarkdown(session: any, config: Config, text: string): Promise<string> {
  if (config.enableQQNativeMarkdown && session.platform === 'qq') {
    const internal = session.bot?.internal as QQSessionBridge | undefined
    if (internal) {
      session['seq'] = session['seq'] || 0;
      const msgSeq = ++session['seq'];
      const payload: QQSendMessageRequest = {
        content: '帮助菜单',
        msg_type: 2,
        msg_id: session.messageId,
        msg_seq: msgSeq,
        markdown: { content: text },
      }
      try {
        if (session.isDirect) {
          await internal.sendPrivateMessage(session.channelId, payload)
        } else {
          await internal.sendMessage(session.channelId, payload)
        }
        return ''
      } catch (error) {
        session.app.logger('help-markdown').warn('QQ native markdown send failed, fallback to text', error)
      }
    }
  }
  return text
}

function getCommands(session: Session, commands: Command[], showHidden = false): Command[] {
  const result: Command[] = []
  for (const command of commands) {
    if (!showHidden && session.resolve(command.config.hidden)) continue
    if (command.match(session) && Object.keys(command._aliases).length) {
      result.push(command)
    } else {
      result.push(...getCommands(session, command.children, showHidden))
    }
  }
  return result
}

async function getVisibleCommands(session: Session, commands: Command[], showHidden = false) {
  const cache = new Map<string, Promise<boolean>>()
  let children = getCommands(session, commands, showHidden)
  const validChildren: Command[] = []
  for (const command of children) {
    const result = await session.app.permissions.test(`command:${command.name}`, session, cache)
    if (result) validChildren.push(command)
  }
  validChildren.sort((a, b) => a.displayName > b.displayName ? 1 : -1)
  return validChildren
}

function getCommandPluginName(cmd: Command, config: Config): string {
  const cid = cmd.ctx && cmd.ctx.name ? cmd.ctx.name : '未分类'
  return config.pluginNameMapping[cid] || cid
}

function formatMqqapi(enableMqqapi: boolean, commandStr: string, text: string) {
  if (enableMqqapi) {
    if (commandStr.endsWith(' -h')) {
      const baseStr = commandStr.slice(0, -3)
      const baseCmd = encodeURIComponent(baseStr + ' ')
      const helpCmd = encodeURIComponent(commandStr)
      return `[${text}](mqqapi://aio/inlinecmd?command=${baseCmd}&enter=false&reply=false) [ [-h] ](mqqapi://aio/inlinecmd?command=${helpCmd}&enter=true&reply=false)`
    }
    return `[${text}](mqqapi://aio/inlinecmd?command=${encodeURIComponent(commandStr)}&enter=true&reply=false)`
  }
  return text
}

export function apply(ctx: Context, config: Config) {
  function enableHelp(command: Command) {
    const prev = command[Context.current]
    command[Context.current] = ctx
    command.option('help', '-h', {
      hidden: true,
      // @ts-ignore
      notUsage: true,
      descPath: 'commands.help.options.help',
    })
    command[Context.current] = prev
  }

  ctx.$commander._commandList.forEach(enableHelp)
  ctx.on('command-added', enableHelp)

  function executeHelp(session: Session, name: string) {
    if (!session.app.$commander.get('help')) return
    return session.execute({
      name: 'help',
      args: [name],
    })
  }

  ctx.before('command/execute', (argv) => {
    const { command, options, session } = argv
    if (options['help'] && command._options.help) {
      return executeHelp(session, command.name)
    }
    if (command['_actions'].length === 0) {
      return executeHelp(session, command.name)
    }
  })

  ctx.command('help [command:string]', '显示帮助信息', { authority: 0 })
    .shortcut('帮助', { fuzzy: true })
    .option('showHidden', '-H 显示隐藏选项和指令')
    .action(async ({ session, options }, target) => {
      const isQQ = session.platform === 'qq' || session.bot?.platform === 'qq'
      const md = config.enableQQNativeMarkdown && isQQ
      const enableMqqapi = md && config.enableQQInlineCmd
      const prefix = session.resolve(session.app.koishi.config.prefix)[0] ?? ''

      if (!target) {
        // 全局指令列表
        const globalCommands = ctx.$commander._commandList.filter(cmd => cmd.parent === null)
        const validCommands = await getVisibleCommands(session, globalCommands, options.showHidden)

        const groups = new Map<string, Command[]>()
        for (const cmd of validCommands) {
          const rawPluginName = cmd.ctx && cmd.ctx.name ? cmd.ctx.name : '未分类'
          const inList = config.pluginList.includes(rawPluginName)
          if (config.filterMode === 'whitelist' && !inList) continue
          if (config.filterMode === 'blacklist' && inList) continue

          const displayPluginName = getCommandPluginName(cmd, config)
          if (!groups.has(displayPluginName)) {
            groups.set(displayPluginName, [])
          }
          groups.get(displayPluginName)!.push(cmd)
        }

        let lines: string[] = []
        if (md) {
          lines.push(`## 帮助中心`)
          lines.push(`欢迎使用机器人服务，以下为指令列表：`)
        } else {
          lines.push(`帮助菜单`)
        }

        for (const [pluginName, cmds] of groups) {
          lines.push('')
          lines.push(md ? `### [ ${pluginName} ]` : `[${pluginName}]`)
          for (const cmd of cmds) {
            let desc = session.text([`commands.${cmd.name}.description`, ''], cmd.config.params) || ''
            let cmdName = prefix + cmd.displayName.replace(/\./g, ' ')
            let runCmdStr = prefix ? `${prefix}${cmd.name} -h` : `/${cmd.name} -h`
            
            let descPart = desc ? `  ${desc}` : ''
            if (enableMqqapi) {
              const inline = formatMqqapi(enableMqqapi, runCmdStr, cmdName)
              lines.push(md ? `- ${inline}${descPart}` : `* ${cmdName}${descPart}`)
            } else {
              lines.push(md ? `- \`${cmdName}\`${descPart}` : `  ${cmdName}${descPart}`)
            }
          }
        }
        
        let epilogText = session.text('.global-epilog', [prefix])
        if (epilogText === 'commands.help.messages.global-epilog') {
          epilogText = `输入 ${prefix || '/'}help <指令名> 查看特定指令的语法和使用示例。`
        }
        
        if (epilogText) {
          lines.push('')
          lines.push(md ? `> ${epilogText}` : epilogText)
        }

        const out = await sendTextOrMarkdown(session, config, lines.join('\n'))
        if (out) return out
        return
      }

      // 单个子指令帮助
      const command = ctx.$commander.resolve(target, session)
      if (!command) {
        let notFoundMsg = `找不到指令：${target}`
        const out = await sendTextOrMarkdown(session, config, notFoundMsg)
        if (out) return out
        return
      }

      const hasPerm = await ctx.permissions.test(`command:${command.name}`, session)
      if (!hasPerm) {
        let noPermMsg = session.text('internal.low-authority')
        const out = await sendTextOrMarkdown(session, config, noPermMsg)
        if (out) return out
        return
      }

      let output: string[] = []
      const title = command.displayName.replace(/\./g, ' ') + (command.declaration || '')
      output.push(md ? `### 指令：${title}` : `指令: ${title}`)
      
      const description = session.text([`commands.${command.name}.description`, ''], command.config.params)
      if (description) {
        output.push(md ? `> ${description}` : description)
      }
      output.push('')

      if (Object.keys(command._aliases).length > 1) {
        const aliases = Array.from(Object.keys(command._aliases).slice(1)).join('，')
        output.push(md ? `**别名**：${aliases}` : `别名: ${aliases}`)
        output.push('')
      }

      output.push(md ? '**用法**：' : '用法:')
      if (command._usage) {
        const usageText = typeof command._usage === 'string' ? command._usage : await command._usage(session)
        const lines = usageText.split('\n')
        for (const line of lines) {
          output.push(md ? `\`${line}\`` : line)
          if (md) output.push('')
        }
      } else {
        const textOption = session.text([`commands.${command.name}.usage`, ''], command.config.params)
        if (textOption) {
          const lines = textOption.split('\n')
          for (const line of lines) {
            output.push(md ? `\`${line}\`` : line)
            if (md) output.push('')
          }
        } else {
          output.push(md ? `\`${prefix}${command.displayName}\`` : `${prefix}${command.displayName}`)
          if (md) output.push('')
        }
      }

      const commandOptions = options.showHidden
        ? Object.values(command._options)
        : Object.values(command._options).filter(opt => !session.resolve(opt.hidden))
      
      if (commandOptions.length) {
        output.push('')
        output.push(md ? '**可用参数**：' : '可用参数:')
        for (const option of commandOptions) {
          function pushOption(opt: any, name: string) {
            let lineItem = md ? `- \`${opt.syntax}\`` : `  ${opt.syntax}`
            const optDesc = session.text(opt.descPath ?? [`commands.${command.name}.options.${name}`, ''], opt.params)
            if (optDesc) lineItem += md ? `  ${optDesc}` : `  ${optDesc}`
            output.push(lineItem)
          }
          if (!('value' in option)) pushOption(option, option.name)
          for (const value in option.variants) {
            pushOption(option.variants[value], `${option.name}.${value}`)
          }
        }
      }

      if (command.children.length) {
        output.push('')
        output.push(md ? '**子指令**：' : '子指令/副指令:')
        const validChildren = await getVisibleCommands(session, command.children, options.showHidden)
        for (const child of validChildren) {
          let desc = session.text([`commands.${child.name}.description`, ''], child.config.params) || ''
          let cmdName = prefix + child.displayName.replace(/\./g, ' ')
          let runCmdStr = prefix ? `${prefix}${child.name} -h` : `/${child.name} -h`

          let descPart = desc ? `  ${desc}` : ''
          if (enableMqqapi) {
            const inline = formatMqqapi(enableMqqapi, runCmdStr, cmdName)
            output.push(md ? `- ${inline}${descPart}` : `* ${cmdName}${descPart}`)
          } else {
            output.push(md ? `- \`${cmdName}\`${descPart}` : `  ${cmdName}${descPart}`)
          }
        }
      }

      if (command._examples.length) {
        output.push('')
        output.push(md ? '**示例**：' : '示例:')
        output.push(...command._examples.map(ex => md ? `- \`${ex}\`` : `  ${ex}`))
      } else {
        const text = session.text([`commands.${command.name}.examples`, ''], command.config.params)
        if (text) {
          output.push('')
          output.push(md ? '**示例**：' : '示例:')
          output.push(...text.split('\n').map(line => md ? `- \`${line}\`` : `  ${line}`))
        }
      }

      const out = await sendTextOrMarkdown(session, config, output.join('\n'))
      if (out) return out
    })
}
