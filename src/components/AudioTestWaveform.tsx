import { audioCalibrationThresholds, calibrationWaveform } from '../audioGain'
import type { CalibrationWaveformPoint } from '../audioGain'

export function AudioTestWaveform({ points, now, gain, forwarding, available }: {
  points: CalibrationWaveformPoint[]
  now: number
  gain: number
  forwarding: boolean
  available: boolean
}) {
  const series = calibrationWaveform(available ? points : [], gain, now, forwarding)
  const topDb = Math.max(6, Math.ceil(Math.max(0, ...series.points.map(p => p.db)) / 6) * 6)
  const width = 760, height = 210, left = 48, right = 128, top = 14, bottom = 178
  const x = (t: number) => left + (t - series.start) / 10_000 * (width - left - right)
  const y = (db: number) => top + (topDb - Math.max(-60, Math.min(topDb, db))) / (topDb + 60) * (bottom - top)
  let previous: number | null = null
  const path = series.points.map(p => {
    const command = previous !== null && p.t - previous <= 60 ? 'L' : 'M'
    previous = p.t
    return `${command}${x(p.t).toFixed(2)},${y(p.db).toFixed(2)}`
  }).join(' ')
  const thresholds = [
    { db: audioCalibrationThresholds.clipping, label: '削波风险 0 dBFS', tone: 'clipping' },
    { db: audioCalibrationThresholds.high, label: '合适上限 −6', tone: 'good' },
    { db: audioCalibrationThresholds.low, label: '合适下限 −24', tone: 'good' },
  ]
  return <section className="audio-calibration-waveform" aria-labelledby="calibration-waveform-title">
    <div className="audio-calibration-waveform-heading"><h3 id="calibration-waveform-title">音量波形</h3><span>增益后估算 · 最近 10 秒</span></div>
    <div className="audio-calibration-waveform-plot">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="增益后峰值随时间变化，合适范围为负 24 至负 6 dBFS，0 dBFS 为削波风险线">
        <rect x={left} y={y(-6)} width={width-left-right} height={y(-24)-y(-6)} fill="#eaf6ef" />
        {[-60, -48, -36, -24, -12, 0, topDb].map(db => <g key={db} className="audio-calibration-grid">
          <line x1={left} x2={width-right} y1={y(db)} y2={y(db)} />
          <text x={left-9} y={y(db)+4} textAnchor="end">{db > 0 ? '+' : ''}{db}</text>
        </g>)}
        {thresholds.map(({ db, label, tone }) => <g key={db} className={`audio-calibration-threshold ${tone}`}>
          <line x1={left} x2={width-right} y1={y(db)} y2={y(db)} />
          <text x={width-right+9} y={y(db)+4}>{label}</text>
        </g>)}
        <path d={path} className="audio-calibration-envelope" />
        {series.points.map(p => <circle key={p.t} cx={x(p.t)} cy={y(p.db)} r={p.db >= 0 ? 2 : 1} fill={p.db >= 0 ? '#be4545' : '#b77d2e'} />)}
        {[0, 2, 4, 6, 8, 10].map(seconds => <text key={seconds} className="audio-calibration-time" x={left+seconds/10*(width-left-right)} y={height-9} textAnchor={seconds===0?'start':seconds===10?'end':'middle'}>{seconds===10?'最近':`−${10-seconds} 秒`}</text>)}
      </svg>
      {!series.points.length && <p className="audio-calibration-waveform-empty">{available ? '暂无波形' : '连接遥控器后显示波形'}</p>}
    </div>
  </section>
}
