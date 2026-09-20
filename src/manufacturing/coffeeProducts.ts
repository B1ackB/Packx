/** Packx-authored discovery metadata. No vendor full text, numerical specification or certification is reproduced. */
export const coffeeDirectoryVersion = "coffee-products.2026-09-18.v1";
export type CoffeeForm = "roasted_beans" | "ground" | "instant";
export const coffeeProductDirectory: Array<{
	id: string; manufacturer: string; product: string; forms: CoffeeForm[]; keywords: string[];
	sourceUrl: string; sourceSection: string; sourceVersion: string | null; termsUrl: string; note: string;
}> = [
	{ id: "cflex-ecolamhighplus", manufacturer: "Constantia Flexibles", product: "EcoLamHighPlus", forms: ["roasted_beans", "ground"], keywords: ["PE", "coffee", "咖啡", "膜", "袋", "阀"], sourceUrl: "https://www.cflex.com/newsroom/paper-film-or-aluminum-how-to-choose-coffee-packaging-that-protects-flavor-and-meets-circularity-targets/", sourceSection: "Flexible films — EcoVerHighPlus & EcoLamHighPlus", sourceVersion: "2025-10-10", termsUrl: "https://www.cflex.com/", note: "产品系列目录线索；逐型号结构及测试数据待索取。" },
	{ id: "cflex-ecoverhighplus", manufacturer: "Constantia Flexibles", product: "EcoVerHighPlus", forms: ["roasted_beans", "ground"], keywords: ["PP", "coffee", "咖啡", "膜", "袋", "阀"], sourceUrl: "https://www.cflex.com/newsroom/paper-film-or-aluminum-how-to-choose-coffee-packaging-that-protects-flavor-and-meets-circularity-targets/", sourceSection: "Flexible films — EcoVerHighPlus & EcoLamHighPlus", sourceVersion: "2025-10-10", termsUrl: "https://www.cflex.com/", note: "系列名称不代表某个订单的完整型号；阀及封口匹配需要单独确认。" },
	{ id: "huhtamaki-bluelite", manufacturer: "Huhtamaki", product: "blueLite", forms: ["ground"], keywords: ["coffee", "咖啡", "咖啡粉", "袋", "无铝"], sourceUrl: "https://www.huhtamaki.com/en/flexible-packaging/market-segments/beverages/coffee/ground-coffee/", sourceSection: "Sustainability at the core", sourceVersion: null, termsUrl: "https://www.huhtamaki.com/", note: "公开介绍按产品家族组织；未获得逐型号 TDS 与入库许可。" },
	{ id: "huhtamaki-blueloop-pe", manufacturer: "Huhtamaki", product: "blueloop PE", forms: ["ground"], keywords: ["PE", "coffee", "咖啡", "咖啡粉", "袋"], sourceUrl: "https://www.huhtamaki.com/en/flexible-packaging/market-segments/beverages/coffee/ground-coffee/", sourceSection: "Sustainability at the core", sourceVersion: null, termsUrl: "https://www.huhtamaki.com/", note: "只有家族级资料入口；包装重量不能用于推算成品袋尺寸。" },
	{ id: "amcor-amprima-coffee", manufacturer: "Amcor", product: "AmPrima Plus for coffee", forms: ["roasted_beans", "ground"], keywords: ["PE", "coffee", "咖啡", "袋", "真空"], sourceUrl: "https://www.amcor.com/sustainability/products/amprima/emea/coffee", sourceSection: "Our AmPrima Plus solutions for coffee", sourceVersion: null, termsUrl: "https://www.amcor.com/termsofuse", note: "EMEA 官方产品目录入口；仅保存自编目录和链接，网站全文复制/索引未获授权。" },
	{ id: "amcor-amfiber-coffee", manufacturer: "Amcor", product: "AmFiber Performance Paper", forms: ["instant"], keywords: ["paper", "纸", "coffee", "咖啡", "速溶", "袋"], sourceUrl: "https://www.amcor.com/products/beverages/coffee/emea", sourceSection: "Making the switch: A technical Q&A on transitioning to paper pouch for instant coffee", sourceVersion: "2026-01-28 (linked Q&A date)", termsUrl: "https://www.amcor.com/termsofuse", note: "速溶咖啡资料入口；不得自动推荐给咖啡豆订单。只保存目录链接，不复制原文。" },
];

export const coffeeSupplierQuestions = [
	{ field: "identity", question: "具体在售型号、牌号及技术资料修订日期是什么？产品系列内哪些配置适用于本订单？" },
	{ field: "structure", question: "从外到内的各层材料、各层厚度和公差是什么？请提供型号对应的 TDS 及页码。" },
	{ field: "barrier", question: "OTR/WVTR 的原值、单位、测试标准、温度、相对湿度和试样厚度分别是什么？" },
	{ field: "format", question: "袋型、灌装方式、阀与拉链是否明确？请提供已确认的成品尺寸或实物打样结果，不能由克重推算。" },
	{ field: "sealing", question: "与客户封口设备匹配的温度、压力、时间及封口强度验证记录是什么？" },
	{ field: "applicability", question: "目标市场、食品接触用途与相关报告覆盖的具体型号、生产场所和有效日期是什么？" },
	{ field: "shelf_life", question: "客户期望的储存期和环境是什么？是否有该咖啡、充气方式与包装组合的验证，不能套用论文时长。" },
	{ field: "commercial", question: "数量、印刷、最小起订量和交期是否确认？报价需单独提供日期、币种、数量阶梯及交付条款。" },
];
