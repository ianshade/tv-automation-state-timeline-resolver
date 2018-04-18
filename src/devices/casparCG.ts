import * as _ from 'underscore'
import { Device, DeviceCommand, DeviceCommandContainer } from './device'

import { CasparCG, Command as CommandNS, AMCPUtil, AMCP } from 'casparcg-connection'
import { Mappings, MappingCasparCG, DeviceType } from './mapping'

import { TimelineState, TimelineResolvedKeyframe, TimelineResolvedObject } from 'superfly-timeline'
import { CasparCG as StateNS, CasparCGState } from 'casparcg-state'

const BGLOADTIME = 1000 // the time we will look back to schedule a loadbg command.

/*
	This is a wrapper for a CasparCG device. All commands will be sent through this
*/
export class CasparCGDevice extends Device {

	private _ccg: CasparCG
	private _ccgState: CasparCGState
	private _queue: { [key: string]: number } = {}
	private _commandReceiver: (time: number, cmd) => void
	private _timeToTimecodeMap: {time: number, timecode: number}

	constructor (deviceId: string, deviceOptions: any, options) {
		super(deviceId, deviceOptions, options)

		if (deviceOptions.options) {
			if (deviceOptions.options.commandReceiver) this._commandReceiver = deviceOptions.options.commandReceiver
			else this._commandReceiver = this._defaultCommandReceiver
		}

		this._ccgState = new CasparCGState({currentTime: this.getCurrentTime})
	}

	/**
	 * Initiates the connection with CasparCG through the ccg-connection lib.
	 */
	init (): Promise<boolean> {

		return new Promise((outerResolve/*, reject*/) => {

			this._ccg = new CasparCG({
				// TODO: add options
			})

			Promise.all([
				new Promise((resolve, reject) => {
					this._ccg.info().then((command) => {
						this._ccgState.initStateFromChannelInfo(_.map(command.response.data, (obj) => { return { channelNo: obj.channel, videoMode: obj.format.toUpperCase(), fps: obj.channelRate } }) as StateNS.ChannelInfo[])

						resolve(true)
					}).catch(() => reject())
				}),new Promise((resolve, reject) => {
					this._ccg.time(1).then((cmd) => { // @todo: keep time per channel
						let segments = (cmd.response.data as string).split(':')
						let time = 0

						// fields:
						time += Number(segments[3]) * 1000 / 50
						// seconds
						time += Number(segments[2]) * 1000
						// minutes
						time += Number(segments[1]) * 60 * 1000
						// hours
						time += Number(segments[0]) * 60 * 60 * 1000

						this._timeToTimecodeMap = { time: this.getCurrentTime(), timecode: time }
						resolve(true)
					}).catch(() => reject())
				})
			]).then(() => {
				outerResolve(true)
			}).catch(() => {
				outerResolve(false)
			})

		})
	}

	terminate (): Promise<boolean> {
		return new Promise((resolve) => {
			this._ccg.disconnect()
			this._ccg.onDisconnected = () => {
				resolve()
			}
		})
	}

	/**
	 * Generates an array of CasparCG commands by comparing the newState against the oldState, or the current device state.
	 * @param newState The state to target.
	 * @param oldState The "current" state of the device. If omitted, will use the actual current state.
	 */
	handleState (newState: TimelineState) {
		let oldState = this.getStateBefore(newState.time) || {time: 0, LLayers: {}, GLayers: {}}

		let newCasparState = this.convertStateToCaspar(newState)
		let oldCasparState = this.convertStateToCaspar(oldState)

		let commandsToAchieveState: Array<CommandNS.IAMCPCommandVO> = this._diffStates(oldCasparState, newCasparState)

		// clear any queued commands on this time:
		let now = this.getCurrentTime()
		for (let token in this._queue) {
			if (this._queue[token] < now) {
				delete this._queue[token]
			} else if (this._queue[token] === newState.time) {
				this._commandReceiver(this.getCurrentTime(), new AMCP.ScheduleRemoveCommand(token))
				delete this._queue[token]
			}
		}

		// add the new commands to the queue:
		this._addToQueue(commandsToAchieveState, oldState, newState.time)

		// store the new state, for later use:
		this.setState(newState)
	}

	clearFuture (clearAfterTime: number) {
		// Clear any scheduled commands after this time
		for (let token in this._queue) {
			if (this._queue[token] > clearAfterTime) this._commandReceiver(this.getCurrentTime(), new AMCP.ScheduleRemoveCommand(token))
		}
	}

	get deviceType () {
		return DeviceType.CASPARCG
	}

	get queue () {
		if (this._queue) {
			return _.map(this._queue, (val, index) => [ val, index ])
		} else {
			return []
		}
	}

	/**
	 * Takes a timeline state and returns a CasparCG State that will work with the state lib.
	 * @param timelineState The timeline state to generate from.
	 */
	convertStateToCaspar (timelineState: TimelineState): StateNS.State {

		const caspar = new StateNS.State()

		_.each(timelineState.LLayers, (layer: TimelineResolvedObject, layerName: string) => {
			const mapping: MappingCasparCG = this.mapping[layerName] as MappingCasparCG

			const channel = caspar.channels[mapping.channel] ? caspar.channels[mapping.channel] : new StateNS.Channel()
			channel.channelNo = Number(mapping.channel) || 1
			// @todo: check if we need to get fps.
			channel.fps = 50
			caspar.channels[channel.channelNo] = channel

			let stateLayer: StateNS.ILayerBase

			if (layer.content.type === 'video') {
				let l: StateNS.IMediaLayer = {
					layerNo: mapping.layer,
					content: StateNS.LayerContentType.MEDIA,
					media: layer.content.attributes.file,
					playTime: layer.resolved.startTime,
					playing: true,

					looping: layer.content.attributes.loop,
					seek: layer.content.attributes.seek
				}
				stateLayer = l
			} else if (layer.content.type === 'ip') {
				let l: StateNS.IMediaLayer = {
					layerNo: mapping.layer,
					content: StateNS.LayerContentType.MEDIA,
					media: layer.content.attributes.uri,
					playTime: layer.resolved.startTime,
					playing: true,
					seek: 0 // ip inputs can't be seeked
				}
				stateLayer = l
			} else if (layer.content.type === 'input') {
				let l: StateNS.IInputLayer = {
					layerNo: mapping.layer,
					content: StateNS.LayerContentType.INPUT,
					media: 'decklink',
					input: {
						device: layer.content.attributes.device
					},
					playing: true
				}
				stateLayer = l
			} else if (layer.content.type === 'template') {
				let l: StateNS.ITemplateLayer = {
					layerNo: mapping.layer,
					content: StateNS.LayerContentType.TEMPLATE,
					media: layer.content.attributes.name,

					playTime: layer.resolved.startTime,
					playing: true,

					templateType: layer.content.attributes.type || 'html',
					templateData: layer.content.attributes.data,
					cgStop: layer.content.attributes.useStopCommand
				}
				stateLayer = l
			} else if (layer.content.type === 'route') {
				if (layer.content.attributes.LLayer) {
					let routeMapping = this.mapping[layer.content.attributes.LLayer] as MappingCasparCG
					if (routeMapping) {
						layer.content.attributes.channel = routeMapping.channel
						layer.content.attributes.layer = routeMapping.layer
					}
				}
				let l: StateNS.IRouteLayer = {
					layerNo: mapping.layer,
					content: StateNS.LayerContentType.ROUTE,
					media: 'route',
					route: {
						channel: layer.content.attributes.channel,
						layer: layer.content.attributes.layer
					},
					playing: true,
					playTime: layer.resolved.startTime
				}
				stateLayer = l
			} else if (layer.content.type === 'record') {
				let l: StateNS.IRecordLayer = {
					layerNo: mapping.layer,
					content: StateNS.LayerContentType.RECORD,
					media: layer.content.attributes.file,
					encoderOptions: layer.content.attributes.encoderOptions,
					playing: true,
					playTime: layer.resolved.startTime
				}
				stateLayer = l
			} else {
				let l: StateNS.IEmptyLayer = {
					content: StateNS.LayerContentType.NOTHING,
					playing: false,
					pauseTime: 0
				}
				stateLayer = l
			}

			if (layer.content.transitions) {
				switch (layer.content.type) {
					case 'video' || 'ip' || 'template' || 'input' || 'route':
						// create transition object
						let media = stateLayer.media
						let transitions = {} as any

						if (layer.content.transitions.inTransition) {
							transitions.inTransition = new StateNS.Transition(
								layer.content.transitions.inTransition.type,
								layer.content.transitions.inTransition.duration,
								layer.content.transitions.inTransition.easing,
								layer.content.transitions.inTransition.direction
							)
						}

						if (layer.content.transitions.outTransition) {
							transitions.outTransition = new StateNS.Transition(
								layer.content.transitions.outTransition.type,
								layer.content.transitions.outTransition.duration,
								layer.content.transitions.outTransition.easing,
								layer.content.transitions.outTransition.direction
							)
						}

						stateLayer.media = new StateNS.TransitionObject(media, {
							inTransition: transitions.inTransition,
							outTransition: transitions.outTransition
						})
						break
					default :
						// create transition using mixer
						break
				}
			}

			if (layer.resolved.mixer) {
				// just pass through values here:
				let mixer: StateNS.Mixer = {}
				_.each(layer.resolved.mixer, (value, property) => {
					mixer[property] = value
				})
				stateLayer.mixer = mixer
			}

			stateLayer.layerNo = mapping.layer

			channel.layers[mapping.layer] = stateLayer
		})

		return caspar

	}

	private _diffStates (oldState, newState): Array<CommandNS.IAMCPCommandVO> {
		let commands: Array<{
			cmds: Array<CommandNS.IAMCPCommandVO>
			additionalLayerState?: StateNS.ILayerBase
		}> = this._ccgState.diffStates(oldState, newState)

		let returnCommands = []

		_.each(commands, (cmdObject) => {
			returnCommands = returnCommands.concat(cmdObject.cmds)
		})

		return returnCommands
	}

	private _addToQueue (commandsToAchieveState, oldState: TimelineState, time: number) {
		_.each(commandsToAchieveState, (cmd) => {
			if (cmd._commandName === 'PlayCommand' && cmd._objectParams.clip !== 'empty') {
				if (oldState.time > 0 && time > this.getCurrentTime()) { // @todo: put the loadbg command just after the oldState.time when convenient?
					let loadbgCmd = Object.assign({}, cmd) // make a deep copy
					loadbgCmd._commandName = 'LoadbgCommand'

					let command = AMCPUtil.deSerialize(loadbgCmd as CommandNS.IAMCPCommandVO, 'id')
					let scheduleCommand = command

					if (oldState.time >= this.getCurrentTime()) {
						scheduleCommand = new AMCP.ScheduleSetCommand({ token: command.token, timecode: this.convertTimeToTimecode(oldState.time), command })
					}
					this._commandReceiver(this.getCurrentTime(), scheduleCommand)

					cmd._objectParams = {
						channel: cmd.channel,
						layer: cmd.layer,
						noClear: cmd._objectParams.noClear
					}
				}
			}

			let command = AMCPUtil.deSerialize(cmd as CommandNS.IAMCPCommandVO, 'id')
			let scheduleCommand = new AMCP.ScheduleSetCommand({ token: command.token, timecode: this.convertTimeToTimecode(time), command })

			if (time <= this.getCurrentTime()) {
				this._commandReceiver(this.getCurrentTime(), command)
			} else {
				this._commandReceiver(this.getCurrentTime(), scheduleCommand)
				this._queue[command.token] = time
			}
		})
	}

	private _defaultCommandReceiver (time: number, cmd) {
		this._ccg.do(cmd).then((resCommand) => {
			if (this._queue[resCommand.token]) {
				delete this._queue[resCommand.token]
			}
		}).catch((e) => {
			console.log(e.response)
			if (cmd.name === 'ScheduleSetCommand') {
				delete this._queue[cmd.getParam('command').token]
			}
		})
	}

	private convertTimeToTimecode (time: number): string {
		let relTime = time - this._timeToTimecodeMap.time
		let timecodeTime = this._timeToTimecodeMap.timecode + relTime

		let timecode = [
			('0' + (Math.floor(timecodeTime / 3.6e6) % 24)).substr(-2),
			('0' + (Math.floor(timecodeTime / 6e4) % 60)).substr(-2),
			('0' + (Math.floor(timecodeTime / 1e3) % 60)).substr(-2),
			('0' + (Math.floor(timecodeTime / 20) % 50)).substr(-2)
		]

		return timecode.join(':')
	}
}