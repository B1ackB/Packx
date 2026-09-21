/** Packx-authored discovery records. Official database contents and supplier specifications are not copied here. */
export const packagingExpansionVersion = "packaging-expansion.2026-09-21.v1";
export const packagingSourceDirectory = [
	{
		id: "fda-fcn", publisher: "U.S. Food and Drug Administration", name: "Food Contact Substance Notifications", kind: "database",
		url: "https://www.fda.gov/food/packaging-food-contact-substances-fcs/inventory-effective-food-contact-substance-fcs-notifications", section: "Launch the Database",
		question: "美国食品接触材料：按 FCN 编号、物质或制造商查通知、预期用途、限制及生效日期。",
		query: "https://www.hfpappexternal.fda.gov/scripts/fdcc/index.cfm?set=FCN",
		limit: "FCN 只适用于通知中的制造商/供应商及规定用途；同名物质、其他供应商或本订单不能自动沿用。这里只登记检索入口，没有复制 FCN 个案。",
	},
	{
		id: "fda-pcr", publisher: "U.S. Food and Drug Administration", name: "Recycled Plastics for Food-Contact Articles", kind: "database",
		url: "https://www.fda.gov/food/packaging-food-contact-substances-fcs/recycled-plastics-food-packaging", section: "Recycled Plastics Database",
		question: "美国食品接触 PCR 再生塑料：按公司、聚合物、NOL 日期和回收工艺查完整使用限制。",
		query: "https://www.hfpappexternal.fda.gov/scripts/fdcc/index.cfm?set=RecycledPlastics",
		limit: "本次另保存 2026-09-04 更新、2026-09-21 下载的官方完整表格快照；使用前仍须在官方入口核对更新。NOL 涉及特定工艺与使用条件，不是产品或订单的通用批准。",
	},
	{
		id: "bpi-products", publisher: "Biodegradable Products Institute", name: "BPI Certified Products Catalog", kind: "database",
		url: "https://bpiworld.org/find-certified-products", section: "Find Certified Products",
		question: "堆肥包装：按公司、产品名称或 SKU 找证书线索，区分商业堆肥与家庭堆肥。",
		query: "https://products.bpiworld.org/",
		limit: "证书须对应具体产品、持有人和有效状态；不可据品牌名称宣称本订单获认证。未批量下载、未获得该目录原文索引许可。",
	},
	{
		id: "recyclass-certificates", publisher: "RecyClass", name: "Recyclability Certificates", kind: "database",
		url: "https://recyclass.eu/certifications/recyclability/recyclability-certificates/", section: "List of certificates",
		question: "塑料包装可回收性：按证书编号、公司、产品名称、袋型、主要聚合物和到期日核对证书线索。",
		query: "https://recyclass.eu/certifications/recyclability/recyclability-certificates/",
		limit: "可回收性评估、食品接触用途和订单验收分别核对。没有复制证书库或授予厂商认证。页面动态筛选，未把空页面当作没有证书。",
	},
	{
		id: "fsc-search", publisher: "Forest Stewardship Council", name: "FSC Search", kind: "database",
		url: "https://search.fsc.org/en/", section: "Certificates (FM and CoC)",
		question: "纸与纸板供应商：按组织名、许可码或证书码核对森林管理/产销监管链证书的范围和状态。",
		query: "https://search.fsc.org/en/",
		limit: "证书持有人存在不等于某张订单或成品可以使用标志；仍需产品组、交易声明及授权核对。只保存入口，无证书批量索引许可。",
	},
	{
		id: "siegwerk-finder", publisher: "Siegwerk", name: "Product & Application Finder", kind: "database",
		url: "https://www.siegwerk.com/en/inks-coatings/printing-inks.html", section: "Product & Application Finder",
		question: "包装油墨：按基材用途和印刷工艺定位产品系列；向对应客户门户索取 TDS、安全资料和成分声明。",
		query: "https://my.siegwerk.com/home",
		limit: "门户资料需客户身份与授权；没有登录、下载客户文件或索引供应商全文。具体油墨迁移、食品接触与工艺匹配仍需资料和人工确认。",
	},
	{
		id: "metsaboard-portfolio", publisher: "Metsä Board", name: "Paperboard Product Portfolio", kind: "database",
		url: "https://www.metsagroup.com/metsaboard/products-and-services/products/product-portfolio/", section: "Metsä Board's product portfolio",
		question: "纸板选型资料：寻找折叠盒纸板 FBB、食品服务纸板 FSB 和白面牛卡纸 WKL 的具体产品表。",
		query: "https://www.metsagroup.com/metsaboard/products-and-services/products/product-portfolio/",
		limit: "未获供应商全文入库许可；厚度、克重、公差、挺度、方向、测试方法及标准条件均不从目录推导。索取准确型号及修订版产品表。",
	},
	{
		id: "upm-paper-catalogue", publisher: "UPM Specialty Materials", name: "Paper Catalogue", kind: "database",
		url: "https://www.upmspecialtymaterials.com/products/paper-catalogue/", section: "Paper Catalogue",
		question: "包装纸与标签纸：按产品类别和地区查找资料入口，再核对具体纸种及技术表版本。",
		query: "https://www.upmspecialtymaterials.com/products/paper-catalogue/",
		limit: "目录包含动态/地区筛选；没有复制纸种技术数据。阻隔性能、可回收性、食品接触条件不能由产品宣传名称推定。",
	},
	{
		id: "goglio-cofres", publisher: "Goglio", name: "CO-FRES", kind: "supplier",
		url: "https://www.goglio.it/en/prodotti/co-fres/", section: "CO-FRES / Optionals / Packaging Lines",
		question: "咖啡包装系统线索：核对 CO-FRES 与包装线、排气阀和封口配置的资料入口。",
		query: "https://www.goglio.it/en/prodotti/co-fres/",
		limit: "未获产品全文索引许可；咖啡形态、袋尺寸、各层材料、阀参数、设备匹配和可生产配置都待具体型号资料，不能由系列名推导。",
	},
	{
		id: "tricorbraun-flex", publisher: "TricorBraun Flex", name: "Coffee & Tea Flexible Packaging Directory", kind: "supplier",
		url: "https://www.tricorbraunflex.com/markets", section: "Coffee & Tea",
		question: "咖啡袋采购线索：从官方目录定位现货袋型、定制印刷与排气阀入口，索取具体 SKU 资料。",
		query: "https://www.tricorbraunflex.com/",
		limit: "未保存价格、交期、规格或供应商全文；灌装重量不能换算成袋尺寸，SKU、阀、材料结构、阻隔条件和订单地区须逐项核对。",
	},
] as const;
