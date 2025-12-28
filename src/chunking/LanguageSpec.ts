/**
 * 多语言配置规范
 *
 * 定义每种语言的层级节点类型和名称提取字段，
 * 用于在遍历 AST 时捕获语义层级。
 */

export interface LanguageSpecConfig {
    /** 触发上下文更新的节点类型 */
    hierarchy: Set<string>;
    /** 提取名称的字段列表（按优先级顺序） */
    nameFields: string[];
}

/**
 * 语言规范映射表
 */
export const LANGUAGE_SPECS: Record<string, LanguageSpecConfig> = {
    typescript: {
        hierarchy: new Set([
            // 类和接口
            "class_declaration",
            "abstract_class_declaration",
            "interface_declaration",
            // 函数
            "function_declaration",
            "generator_function_declaration",
            "method_definition",
            "arrow_function",
            // 模块
            "export_statement",
            "import_statement",
        ]),
        nameFields: ["name", "id"],
    },

    javascript: {
        hierarchy: new Set([
            "class_declaration",
            "function_declaration",
            "generator_function_declaration",
            "method_definition",
            "arrow_function",
        ]),
        nameFields: ["name", "id"],
    },

    python: {
        hierarchy: new Set([
            "class_definition",
            "function_definition",
            "decorated_definition",
        ]),
        nameFields: ["name"],
    },

    go: {
        hierarchy: new Set([
            // 函数和方法
            "function_declaration",
            "method_declaration",
            // 类型定义
            "type_spec",
            "type_declaration",
            // 结构体和接口
            "struct_type",
            "interface_type",
        ]),
        nameFields: ["name"],
    },

    rust: {
        hierarchy: new Set([
            // 函数
            "function_item",
            // 结构体、枚举、trait
            "struct_item",
            "enum_item",
            "trait_item",
            // impl 块
            "impl_item",
            // 模块
            "mod_item",
            // 类型别名
            "type_item",
        ]),
        nameFields: ["name"],
    },

    java: {
        hierarchy: new Set([
            // 类和接口
            "class_declaration",
            "interface_declaration",
            "enum_declaration",
            "annotation_type_declaration",
            // 方法和构造函数
            "method_declaration",
            "constructor_declaration",
            // 记录类型 (Java 14+)
            "record_declaration",
        ]),
        nameFields: ["name", "identifier"],
    },
};

/**
 * 获取指定语言的规范配置
 * @param language 语言标识
 * @returns 语言规范配置，如果不支持则返回 null
 */
export function getLanguageSpec(language: string): LanguageSpecConfig | null {
    return LANGUAGE_SPECS[language] ?? null;
}

/**
 * 检查语言是否支持 AST 分片
 */
export function isAstSupported(language: string): boolean {
    return language in LANGUAGE_SPECS;
}
