import { MODELS, json } from '../_shared.js';

export async function onRequestGet(context) {
  // 只暴露前端需要展示的字段，endpoint / keyEnv 等服务端配置不返回
  const publicModels = MODELS.map(({ id, name, color, model }) => ({
    id, name, color, model,
  }));
  return json({ models: publicModels });
}
