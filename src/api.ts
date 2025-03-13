import { DataSourcePluginOptionsEditorProps } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { MySecureJsonData ,MyDataSourceOptions} from 'types';
import { firstValueFrom } from 'rxjs';

export interface PrtgApiConfig {
    url: string;
    token?: string;
    apiVersion?: string;
}

export class PrtgApi {
    config: PrtgApiConfig;
    
    constructor(instanceSettings: DataSourcePluginOptionsEditorProps<MyDataSourceOptions,MySecureJsonData>) {
        this.config = {
            url: instanceSettings.options.url || '',
            token: instanceSettings.options.secureJsonData?.apiToken || '',
            apiVersion: instanceSettings.options.jsonData?.apiVersion || 'v1',
        };
        
        // Remove trailing slash from URL if exists
        if (this.config.url.endsWith('/')) {
            this.config.url = this.config.url.slice(0, -1);
        }
    }

    async login(): Promise<string> {
        const url = `${this.config.url}/api/table.json`;
        const params = {
            apiToken: this.config.token,
            content: 'login',
        };

        try {
            const response = await this.request('GET', url, params);
            return response.sessionid;
        } catch (error) {
            console.error('PRTG login failed:', error);
            throw new Error('Failed to login to PRTG');
        }
    }

    async getSensors(filters?: Record<string, any>): Promise<any[]> {
        const url = `${this.config.url}/api/table.json`;
        const params = {
            content: 'sensors',
            columns: 'objid,device,sensor,status,message,lastvalue,type',
            count: 5000,
            ...filters,
        };

        const response = await this.request('GET', url, params);
        return response.sensors || [];
    }

    async getDevices(filters?: Record<string, any>): Promise<any[]> {
        const url = `${this.config.url}/api/table.json`;
        const params = {
            content: 'devices',
            columns: 'objid,device,status,message,parentid',
            count: 5000,
            ...filters,
        };

        const response = await this.request('GET', url, params);
        return response.devices || [];
    }

    async getSensorHistory(sensorId: number, startDate: string, endDate: string): Promise<any> {
        const url = `${this.config.url}/api/historicdata.json`;
        const params = {
            id: sensorId,
            avg: 0,
            sdate: startDate,
            edate: endDate,
        };

        return this.request('GET', url, params);
    }

    private async request(method: string, url: string, params: Record<string, any>): Promise<any> {
        const options = {
            method,
            url,
            params,
            headers: { 'Content-Type': 'application/json' },
        };
        try {
            const response = await firstValueFrom(getBackendSrv().fetch(options));
            if (!response) {
                throw new Error('Empty response received from PRTG API');
            }
            return response.data;
            return response.data;
        } catch (error) {
            console.error('PRTG API request failed:', error);
            throw error;
        }
    }
}
