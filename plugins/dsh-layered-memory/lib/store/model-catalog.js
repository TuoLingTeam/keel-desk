const MODEL_CATALOG = [
  {
    id: "bge-small-zh-v1.5",
    name: "BGE small \u4E2D\u6587",
    repo: "Xenova/bge-small-zh-v1.5",
    revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
    dims: 512,
    contextTokens: 512,
    pooling: "cls",
    tags: ["\u4E2D\u6587", "\u8F7B\u91CF"],
    description: "\u4E2D\u6587\u4E13\u7528\u5C0F\u6A21\u578B\uFF1A\u7EA6 25MB\uFF0CCPU \u5D4C\u5165\u6700\u5FEB\uFF0C\u9002\u5408\u5148\u4F53\u9A8C\u8BED\u4E49\u68C0\u7D22\u3002",
    files: [
      { path: "config.json", size: 716, sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f" },
      { path: "tokenizer_config.json", size: 367, sha256: "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a" },
      { path: "special_tokens_map.json", size: 125, sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3" },
      { path: "tokenizer.json", size: 439125, sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26" },
      { path: "onnx/model_quantized.onnx", size: 24010842, sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc" }
    ]
  },
  {
    id: "embeddinggemma-300m",
    name: "EmbeddingGemma 300M",
    repo: "onnx-community/embeddinggemma-300m-ONNX",
    revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
    dims: 768,
    contextTokens: 2048,
    pooling: "mean",
    tags: ["\u591A\u8BED\u8A00", "\u5747\u8861"],
    description: "Google \u5B98\u65B9\u5D4C\u5165\u6A21\u578B\uFF1A100+ \u8BED\u8A00\u542B\u4E2D\u6587\uFF0C\u7EA6 295MB\uFF0C\u8D28\u91CF\u4E0E\u5F00\u9500\u5747\u8861\uFF08\u4E0A\u6E38 MemoryCore \u540C\u6B3E\uFF09\u3002",
    files: [
      { path: "config.json", size: 1765, sha256: "6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b" },
      { path: "added_tokens.json", size: 35, sha256: "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946" },
      { path: "special_tokens_map.json", size: 662, sha256: "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397" },
      { path: "tokenizer_config.json", size: 1156830, sha256: "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a" },
      { path: "generation_config.json", size: 133, sha256: "1fb1efd221c1ca88a736d1b36cb47d754c177677e222acb3b1e5424c5d664870" },
      { path: "tokenizer.json", size: 20323312, sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47" },
      { path: "onnx/model_quantized.onnx", size: 567874, sha256: "172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8" },
      { path: "onnx/model_quantized.onnx_data", size: 308890624, sha256: "705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0" }
    ]
  },
  {
    id: "bge-m3",
    name: "BGE-M3 \u5927\u676F",
    repo: "Xenova/bge-m3",
    revision: "4de13258303883538bd53b696b452bf8099f0858",
    dims: 1024,
    contextTokens: 8192,
    pooling: "cls",
    tags: ["\u4E2D\u6587", "\u957F\u4E0A\u4E0B\u6587"],
    description: "\u4E2D\u6587\u8D28\u91CF\u6700\u5F3A\uFF1A8192 token \u4E0A\u4E0B\u6587\uFF0C\u7EA6 543MB\uFF0CCPU \u5D4C\u5165\u8F83\u6162\uFF08\u5355\u6761\u53EF\u8FBE\u79D2\u7EA7\uFF09\u3002",
    files: [
      { path: "config.json", size: 770, sha256: "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95" },
      { path: "special_tokens_map.json", size: 964, sha256: "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835" },
      { path: "tokenizer_config.json", size: 1173, sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4" },
      { path: "tokenizer.json", size: 17082821, sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790" },
      { path: "onnx/model_quantized.onnx", size: 569694530, sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d" }
    ]
  }
];
function catalogById(id) {
  return MODEL_CATALOG.find((m) => m.id === id);
}
function catalogTotalBytes(entry) {
  return entry.files.reduce((sum, f) => sum + f.size, 0);
}
export {
  MODEL_CATALOG,
  catalogById,
  catalogTotalBytes
};
