"use client";

import Icon from "./Icon";
import type { BackendLocation } from "@/lib/backend";

export type BackendOption = { id: BackendLocation; name: string; detail: string; configured: boolean };

export default function BackendPicker({ value, onChange, options, disabled }: { value: BackendLocation; onChange: (value: BackendLocation) => void; options: BackendOption[]; disabled: boolean }) {
  return <fieldset className="backend-picker" disabled={disabled}>
    <legend>处理位置</legend>
    <div className="backend-options">{options.map(option => <label key={option.id} className={`backend-option ${value === option.id ? "selected" : ""} ${!option.configured ? "unavailable" : ""}`}>
      <input type="radio" name="backend-location" value={option.id} checked={value === option.id} disabled={!option.configured || disabled} onChange={() => onChange(option.id)} />
      <span className="backend-option-icon"><Icon name={option.id === "modal" ? "sparkles" : "queue"} size={20} /></span>
      <span className="backend-option-copy"><strong>{option.name}<small>{option.id === "modal" ? "GPU 加速" : "当前服务器"}</small></strong><span>{option.configured ? option.id === "modal" ? "L4 · BiRefNet Lite + RetinaFace" : "Oracle · CPU 处理" : "暂未配置"}</span></span>
      <span className="backend-radio">{value === option.id && <Icon name="check" size={12} />}</span>
    </label>)}</div>
    <p className="backend-hint">{disabled ? "处理位置已锁定，完成后可以切换。" : "本次队列将在所选位置处理，照片完成后回到照片库下载。"}</p>
  </fieldset>;
}
