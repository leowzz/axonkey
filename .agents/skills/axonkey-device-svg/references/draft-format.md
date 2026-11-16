# 图稿草稿格式

这是正式 `axonkey.device/1` 的**图稿制作子集**，用于尚未取得设备报告的接入准备，不是运行时支持的新协议或可启用设备。正式格式以[协议文档](../../../../docs/DEVICE_DESCRIPTOR_SVG.md)为准。

## 状态和输入

根 SVG 保持标准命名空间、版本及一致的 device/revision；另外标记 `data-ak-status="draft"`，`ak:device` 标记 `status="draft"`。这些标记只供制作工具辨识，不能假定当前运行时会据此安全停用设备。

```xml
<svg xmlns="http://www.w3.org/2000/svg" xmlns:ak="urn:axonkey:device:1"
     viewBox="0 0 240 600" data-ak-schema="axonkey.device/1"
     data-ak-device="brand.model" data-ak-revision="1" data-ak-status="draft">
  <metadata>
    <ak:device schema="axonkey.device/1" id="brand.model" vendor="Brand"
               model="Model" revision="1" display-name="Brand Model" status="draft">
      <ak:inputs>
        <ak:input id="brand.model.power" label="电源键" short="电源" icon="power"
                  kind="button" order="0" target="#power" original="false" binding="pending" />
      </ak:inputs>
    </ak:device>
  </metadata>
  <g data-ak-view="front">
    <g id="power" data-ak-key="brand.model.power" data-ak-role="input"
       aria-label="电源键" role="button" tabindex="0">
      <circle cx="120" cy="50" r="20" fill="#24272b" />
    </g>
  </g>
  <g data-ak-regions="true" fill="transparent" pointer-events="none">
    <path data-ak-region="brand.model.power" data-ak-anchor="120 50"
          d="M 100 50 a 20 20 0 1 0 40 0 a 20 20 0 1 0 -40 0" />
  </g>
</svg>
```

`id/label/short/icon/kind/order/target/original` 沿用正式输入字段；`binding="pending"` 是制作状态。`icon` 选 `src/appTypes.ts` 中已有的 `RemoteButton['icon']` 值，不使用 Lucide 组件名称；看不清的按键可用中性 `center`。实际图稿只画照片确有的按键；此例不是设备模板。

未知值完全省略：不创建 `ak:source`、`ak:report(s)`、`ak:voice`、`ak:identity` 或 `ak:match`，input 上也不填 `report/page/usage/engine/field/equals/legacy-key`。当前运行时因缺少 identity/source 而拒绝解析，后续正式接入必须补齐，不能仅删掉 draft 标记。

## 已知匹配条件

交接记录写清用户提供的每项条件和 AND/OR 关系。需要机器可读保留时，可放以下**待接入记录**；这些元素不声明已实现运行时匹配。

```xml
<ak:pending-identity hardware-id="DEV_VID&amp;010416_PID&amp;0301" vid="0x0416" pid="0x0301" operator="and">
  <ak:condition characteristic="0x2A24" contains="BT_RC802A" />
  <ak:condition characteristic="0x2A29" contains="TCL" />
</ak:pending-identity>
```

这里的 TCL 条件仅演示本次用户提供的 RC802A 身份，不可复制给其他设备。原始硬件字符串保留完整；VID/PID 的规范化值也不能替代附加 GATT 条件。

## 交接记录

同名 `.md` 只需保留后续接入会用的信息：品牌/型号及来源、草稿状态、稳定输入 ID 和视图、照片不确定项、完整匹配规则。实际按键值与音频协议标为待采集，不推测数值，不复制照片到仓库当作 SVG 的背景。

后续录入真实 source 时保持现有稳定 ID 和区域路径。增加报告与身份校验后再移入正式目录，按项目现有解析器、生成器和测试验证。图稿通过结构检查不代表设备已能发现、绑定、输入或录音。
