/**
 * @file Vue Router configuration
 * @description Defines the application routes and router instance with HTML5 history mode.
 *              Base path 取自构建期的 import.meta.env.BASE_URL（即 vite `base`），
 *              因此换部署路径时无需改代码，用部署脚本指定即可：
 *                  pnpm build:deploy -- --base=/
 *              默认构建下 BASE_URL 仍为 /gis-tools/，行为与原先完全一致。
 *              Includes a beforeEach guard for document title.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-04-13
 */
import {createRouter, createWebHistory} from 'vue-router'


export const constantRoutes = [

    {
        path: '/',
        name: 'GisData',
        component: () => import('~/components/data/GisData.vue'),
        // component: () => import('~/components/Home.vue'),
    },
    {
        path: '/data',
        name: 'GisDataReader',
        component: () => import('~/components/data/GisData.vue'),
    },
    // 兜底：未匹配的路径一律回首页
    //
    // 说明（IIS/子目录部署的关键坑）：
    //   createWebHistory(import.meta.env.BASE_URL) 内部用 stripBase(pathname, base)，
    //   当 base = '/gis-tools/' 而实际访问 '/gis-tools'（无尾斜杠）时，
    //   pathname.startsWith(base) 为 false，path 会原样保留成 '/gis-tools'，
    //   既不匹配 '/' 也不匹配 '/data'，<router-view> 渲染空 —— 表现就是白屏。
    //   这里加 catch-all 兜底，无论带不带尾斜杠都能落到首页。
    {
        path: '/:pathMatch(.*)*',
        redirect: '/',
    },
]

const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [...constantRoutes]
})
const title = 'Gis Tools';
router.beforeEach((to, _from, next) => {
    const _title: string = (to?.meta?.title as string) || (to?.name as string) || '';
    document.title = _title ? `${title} - ${_title}` : title;
    next();
})

export default router;
